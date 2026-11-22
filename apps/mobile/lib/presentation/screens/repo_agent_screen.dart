import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_markdown/flutter_markdown.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../core/di/providers.dart';
import '../../core/providers/selected_model_provider.dart';
import '../../core/theme/app_theme.dart';
import '../../core/utils/cancel_token.dart';
import '../../domain/entities/agent_session.dart';
import '../../domain/entities/github_repo.dart';
import '../../domain/entities/user_api_keys.dart';
import '../widgets/model_picker_chip.dart';

/// Works inside one GitHub repo with the ARO coding agent: the user
/// describes a task, ARO explores the code, edits it and pushes commits.
class RepoAgentScreen extends ConsumerStatefulWidget {
  final GitHubRepo repo;

  const RepoAgentScreen({super.key, required this.repo});

  @override
  ConsumerState<RepoAgentScreen> createState() => _RepoAgentScreenState();
}

class _RepoAgentScreenState extends ConsumerState<RepoAgentScreen> {
  final _input = TextEditingController();
  final _scroll = ScrollController();

  AgentSession? _session;
  final List<AgentTimelineItem> _timeline = [];
  bool _running = false;
  String? _liveStatus;
  CancelToken? _cancelToken;

  // Settings for the next new session.
  late String _baseBranch = widget.repo.defaultBranch;
  bool _pushDirect = false;
  List<String> _branches = const [];

  @override
  void initState() {
    super.initState();
    _loadBranches();
  }

  @override
  void dispose() {
    _cancelToken?.cancel();
    _input.dispose();
    _scroll.dispose();
    super.dispose();
  }

  Future<void> _loadBranches() async {
    final uid = ref.read(firebaseServiceProvider).currentUserId;
    if (uid == null) return;
    try {
      final keys = await ref.read(userSettingsRepositoryProvider).getApiKeys(uid);
      if (!keys.hasGitHub) return;
      final branches = await ref.read(gitHubApiProvider).listBranches(keys.github!, widget.repo.owner, widget.repo.name);
      if (mounted) setState(() => _branches = branches);
    } catch (_) {
      // The default branch still works without the list.
    }
  }

  void _scrollToEnd() {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (_scroll.hasClients) {
        _scroll.animateTo(_scroll.position.maxScrollExtent, duration: const Duration(milliseconds: 250), curve: Curves.easeOut);
      }
    });
  }

  void _openSession(AgentSession session) {
    setState(() {
      _session = session;
      _timeline
        ..clear()
        ..addAll(session.timeline);
      _liveStatus = null;
    });
    _scrollToEnd();
  }

  void _newSession() {
    if (_running) return;
    setState(() {
      _session = null;
      _timeline.clear();
      _liveStatus = null;
    });
  }

  Future<void> _confirmDirectPush(bool value) async {
    if (!value) {
      setState(() => _pushDirect = false);
      return;
    }
    final ok = await showDialog<bool>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        backgroundColor: AppColors.surfaceRaised,
        title: Text('Push straight to $_baseBranch?'),
        content: Text(
          'ARO will commit directly to "$_baseBranch" with no pull request to review first. '
          'Leave this off to have ARO push to its own branch and open a pull request instead.',
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(dialogContext, false), child: const Text('Keep it off')),
          FilledButton(onPressed: () => Navigator.pop(dialogContext, true), child: const Text('Push directly')),
        ],
      ),
    );
    if (mounted) setState(() => _pushDirect = ok == true);
  }

  Future<void> _run({String? message, bool continueRun = false}) async {
    if (_running) return;
    final uid = ref.read(firebaseServiceProvider).currentUserId;
    if (uid == null) return;

    final keys = await ref.read(userSettingsRepositoryProvider).getApiKeys(uid);
    if (!keys.hasGitHub) {
      _showError('Connect GitHub first.');
      return;
    }
    final option = ref.read(selectedModelProvider);
    final apiKey = UserApiKeys.requiresKey(option.provider) ? (keys.forProvider(option.provider) ?? '') : '';
    if (UserApiKeys.requiresKey(option.provider) && apiKey.trim().isEmpty) {
      _showError('No API key for ${option.label}. Add one in API Providers, or pick ARO 1.5.');
      return;
    }

    final now = DateTime.now();
    var session = _session ??
        AgentSession(
          id: '',
          ownerId: uid,
          repoOwner: widget.repo.owner,
          repoName: widget.repo.name,
          title: _titleFrom(message ?? 'Task'),
          baseBranch: _baseBranch,
          pushMode: _pushDirect ? 'direct' : 'branch',
          createdAt: now,
          updatedAt: now,
        );

    if (message != null) {
      _timeline.add(AgentTimelineItem(kind: 'user', text: message, at: now));
      _input.clear();
    }
    final cancelToken = CancelToken();
    setState(() {
      _running = true;
      _liveStatus = 'Starting…';
      _cancelToken = cancelToken;
    });
    _scrollToEnd();

    final toolIndex = <String, int>{};
    var status = 'idle';
    String? stateJson = session.stateJson;
    String? workBranch = session.workBranch;
    var commitCount = session.commitCount;
    String? prUrl = session.pullRequestUrl;

    try {
      final stream = ref.read(agentClientProvider).run(
            provider: option.provider,
            model: keys.modelFor(option.provider),
            apiKey: apiKey,
            githubToken: keys.github!,
            repoOwner: widget.repo.owner,
            repoName: widget.repo.name,
            baseBranch: session.baseBranch,
            pushMode: session.pushMode,
            message: message,
            continueRun: continueRun,
            state: stateJson == null ? null : jsonDecode(stateJson) as Map<String, dynamic>,
            cancelToken: cancelToken,
          );

      await for (final event in stream) {
        if (!mounted) return;
        final at = DateTime.now();
        setState(() {
          switch (event.type) {
            case 'status':
              _liveStatus = event.text;
            case 'text':
              _timeline.add(AgentTimelineItem(kind: 'text', text: event.text, at: at));
            case 'tool':
              toolIndex[event.data['id'] as String? ?? ''] = _timeline.length;
              _timeline.add(AgentTimelineItem(
                kind: 'tool',
                text: event.data['input'] as String? ?? '',
                detail: event.data['name'] as String?,
                at: at,
              ));
            case 'tool_result':
              final index = toolIndex[event.data['id'] as String? ?? ''];
              if (index != null) {
                final ok = event.data['ok'] == true;
                _timeline[index] = _timeline[index].copyWith(
                  ok: ok,
                  text: ok ? null : '${_timeline[index].text} — ${event.data['summary'] ?? 'failed'}',
                );
              }
            case 'commit':
              _timeline.add(AgentTimelineItem(
                kind: 'commit',
                text: event.data['message'] as String? ?? '',
                detail: '${(event.data['sha'] as String? ?? '').padRight(7).substring(0, 7)} → ${event.data['branch']}',
                url: event.data['url'] as String?,
                at: at,
              ));
            case 'pull_request':
              prUrl = event.data['url'] as String?;
              _timeline.add(AgentTimelineItem(kind: 'pr', text: 'Pull request #${event.data['number']}', url: prUrl, at: at));
            case 'error':
              status = 'error';
              _timeline.add(AgentTimelineItem(kind: 'error', text: event.text, ok: false, at: at));
            case 'state':
              final state = event.data['state'] as Map<String, dynamic>?;
              if (state != null) {
                stateJson = jsonEncode(state);
                workBranch = state['workBranch'] as String?;
                commitCount = (state['commits'] as List?)?.length ?? commitCount;
                prUrl = (state['pullRequest'] as Map?)?['url'] as String? ?? prUrl;
              }
            case 'done':
              final s = event.data['status'] as String?;
              status = s == 'paused' ? 'paused' : (s == 'error' ? 'error' : 'idle');
          }
        });
        _scrollToEnd();
      }
    } catch (e) {
      status = 'error';
      if (mounted) {
        setState(() => _timeline.add(AgentTimelineItem(kind: 'error', text: _friendly(e), ok: false, at: DateTime.now())));
      }
    } finally {
      if (cancelToken.isCancelled) {
        status = 'paused';
        _timeline.add(AgentTimelineItem(
          kind: 'status',
          text: 'Stopped. Steps after the last saved point may need to be redone.',
          at: DateTime.now(),
        ));
      }
      session = session.copyWith(
        status: status,
        stateJson: stateJson,
        workBranch: workBranch,
        commitCount: commitCount,
        pullRequestUrl: prUrl,
        timeline: List.of(_timeline),
        updatedAt: DateTime.now(),
      );
      try {
        session = await ref.read(agentSessionRepositoryProvider).save(session);
      } catch (_) {
        // Still keep the session in memory so the user can continue.
      }
      if (mounted) {
        setState(() {
          _session = session;
          _running = false;
          _liveStatus = null;
          _cancelToken = null;
        });
      }
    }
  }

  String _titleFrom(String text) {
    final line = text.replaceAll('\n', ' ').trim();
    return line.length <= 60 ? line : '${line.substring(0, 60)}…';
  }

  String _friendly(Object e) =>
      e.toString().replaceFirst('HttpException: ', '').replaceFirst('StateError: ', '').replaceFirst('Exception: ', '');

  void _showError(String message) {
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(message)));
  }

  void _showSessions() {
    final uid = ref.read(firebaseServiceProvider).currentUserId;
    if (uid == null) return;
    showModalBottomSheet(
      context: context,
      backgroundColor: AppColors.surfaceRaised,
      shape: const RoundedRectangleBorder(borderRadius: BorderRadius.vertical(top: Radius.circular(AppRadii.xl))),
      builder: (sheetContext) => SafeArea(
        child: StreamBuilder<List<AgentSession>>(
          stream: ref.read(agentSessionRepositoryProvider).watchSessions(uid, widget.repo.owner, widget.repo.name),
          builder: (context, snapshot) {
            final sessions = snapshot.data ?? const [];
            if (snapshot.connectionState == ConnectionState.waiting) {
              return const Padding(padding: EdgeInsets.all(32), child: Center(child: CircularProgressIndicator()));
            }
            if (sessions.isEmpty) {
              return const Padding(padding: EdgeInsets.all(32), child: Text('No past tasks in this repo yet.'));
            }
            return ListView(
              shrinkWrap: true,
              children: sessions
                  .map((s) => ListTile(
                        leading: Icon(
                          s.status == 'paused' ? Icons.pause_circle_outline_rounded : Icons.task_alt_rounded,
                          color: s.status == 'error' ? Colors.redAccent : AppColors.accentBlue,
                        ),
                        title: Text(s.title, maxLines: 1, overflow: TextOverflow.ellipsis),
                        subtitle: Text(
                          '${s.commitCount} commit${s.commitCount == 1 ? '' : 's'} · ${s.workBranch ?? s.baseBranch}',
                          style: const TextStyle(color: AppColors.textMuted, fontSize: 12),
                        ),
                        onTap: () {
                          Navigator.pop(sheetContext);
                          _openSession(s);
                        },
                      ))
                  .toList(),
            );
          },
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: Text(widget.repo.fullName, overflow: TextOverflow.ellipsis),
        actions: [
          IconButton(icon: const Icon(Icons.history_rounded), tooltip: 'Past tasks', onPressed: _showSessions),
          IconButton(icon: const Icon(Icons.add_rounded), tooltip: 'New task', onPressed: _running ? null : _newSession),
        ],
      ),
      body: Column(
        children: [
          Expanded(
            child: _timeline.isEmpty && _session == null
                ? _buildIntro()
                : ListView.builder(
                    controller: _scroll,
                    padding: const EdgeInsets.all(16),
                    itemCount: _timeline.length + (_liveStatus != null ? 1 : 0),
                    itemBuilder: (context, index) {
                      if (index == _timeline.length) return _LiveStatus(text: _liveStatus!);
                      return _TimelineTile(item: _timeline[index]);
                    },
                  ),
          ),
          if (!_running && _session?.status == 'paused')
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 0, 16, 8),
              child: OutlinedButton.icon(
                onPressed: () => _run(continueRun: true),
                icon: const Icon(Icons.play_arrow_rounded),
                label: const Text('Continue'),
              ),
            ),
          _buildComposer(),
        ],
      ),
    );
  }

  Widget _buildIntro() {
    final branches = {widget.repo.defaultBranch, ..._branches}.toList();
    return ListView(
      padding: const EdgeInsets.all(20),
      children: [
        Text('What should ARO do?', style: Theme.of(context).textTheme.headlineMedium),
        const SizedBox(height: 6),
        Text(
          'Describe a bug to fix or a change to make. ARO reads the code, edits it and pushes the change to GitHub.',
          style: Theme.of(context).textTheme.bodyMedium,
        ),
        const SizedBox(height: 20),
        Row(
          children: [
            const Icon(Icons.call_split_rounded, size: 18, color: AppColors.textMuted),
            const SizedBox(width: 8),
            const Text('Base branch', style: TextStyle(color: AppColors.textSecondary)),
            const Spacer(),
            DropdownButton<String>(
              value: branches.contains(_baseBranch) ? _baseBranch : widget.repo.defaultBranch,
              dropdownColor: AppColors.surfaceRaised,
              items: branches.map((b) => DropdownMenuItem(value: b, child: Text(b))).toList(),
              onChanged: (b) => setState(() => _baseBranch = b ?? _baseBranch),
            ),
          ],
        ),
        SwitchListTile(
          contentPadding: EdgeInsets.zero,
          value: _pushDirect,
          activeThumbColor: AppColors.accentBlue,
          onChanged: _confirmDirectPush,
          title: Text('Push directly to $_baseBranch', style: const TextStyle(color: AppColors.textPrimary)),
          subtitle: Text(
            _pushDirect
                ? 'Commits land on $_baseBranch right away.'
                : 'Off: ARO pushes to its own aro/… branch and opens a pull request for you to merge.',
            style: const TextStyle(color: AppColors.textMuted, fontSize: 12),
          ),
        ),
        const SizedBox(height: 12),
        const Text('Try:', style: TextStyle(color: AppColors.textMuted)),
        const SizedBox(height: 6),
        for (final example in const [
          'Find out why the login screen crashes and fix it',
          'Add input validation to the signup form',
          'Write a README explaining how to run this project',
        ])
          Padding(
            padding: const EdgeInsets.only(bottom: 6),
            child: ActionChip(
              label: Text(example),
              backgroundColor: AppColors.surface,
              side: const BorderSide(color: AppColors.border),
              onPressed: () => _input.text = example,
            ),
          ),
      ],
    );
  }

  Widget _buildComposer() {
    return SafeArea(
      top: false,
      child: Container(
        margin: const EdgeInsets.fromLTRB(12, 4, 12, 12),
        padding: const EdgeInsets.fromLTRB(14, 6, 6, 6),
        decoration: BoxDecoration(
          color: AppColors.surface,
          borderRadius: BorderRadius.circular(AppRadii.lg),
          border: Border.all(color: AppColors.border),
        ),
        child: Column(
          children: [
            TextField(
              controller: _input,
              enabled: !_running,
              minLines: 1,
              maxLines: 6,
              style: const TextStyle(color: AppColors.textPrimary),
              decoration: InputDecoration(
                hintText: _session == null ? 'Describe the task…' : 'Ask for a follow-up change…',
                border: InputBorder.none,
                enabledBorder: InputBorder.none,
                focusedBorder: InputBorder.none,
                disabledBorder: InputBorder.none,
                filled: false,
              ),
            ),
            Row(
              children: [
                const ModelPickerChip(),
                const Spacer(),
                if (_running)
                  IconButton(
                    icon: const Icon(Icons.stop_circle_rounded, color: Colors.redAccent),
                    tooltip: 'Stop',
                    onPressed: () => _cancelToken?.cancel(),
                  )
                else
                  IconButton(
                    icon: const Icon(Icons.arrow_upward_rounded, color: AppColors.accentBlue),
                    tooltip: 'Send',
                    onPressed: () {
                      final text = _input.text.trim();
                      if (text.isNotEmpty) _run(message: text);
                    },
                  ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}

class _LiveStatus extends StatelessWidget {
  final String text;
  const _LiveStatus({required this.text});

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 8),
      child: Row(
        children: [
          const SizedBox(width: 14, height: 14, child: CircularProgressIndicator(strokeWidth: 2, color: AppColors.accentBlue)),
          const SizedBox(width: 10),
          Expanded(child: Text(text, style: const TextStyle(color: AppColors.textMuted, fontStyle: FontStyle.italic))),
        ],
      ),
    );
  }
}

class _TimelineTile extends StatelessWidget {
  final AgentTimelineItem item;
  const _TimelineTile({required this.item});

  static const _toolLabels = {
    'list_files': ('Listed files', Icons.folder_open_rounded),
    'read_file': ('Read', Icons.description_outlined),
    'search_code': ('Searched', Icons.search_rounded),
    'write_file': ('Wrote', Icons.edit_document),
    'edit_file': ('Edited', Icons.edit_outlined),
    'delete_file': ('Deleted', Icons.delete_outline_rounded),
    'commit_and_push': ('Committed & pushed', Icons.cloud_upload_outlined),
    'create_pull_request': ('Opened pull request', Icons.merge_type_rounded),
    'get_ci_status': ('Checked CI', Icons.fact_check_outlined),
  };

  Future<void> _open(String? url) async {
    if (url == null) return;
    await launchUrl(Uri.parse(url), mode: LaunchMode.externalApplication);
  }

  @override
  Widget build(BuildContext context) {
    switch (item.kind) {
      case 'user':
        return Align(
          alignment: Alignment.centerRight,
          child: Container(
            margin: const EdgeInsets.symmetric(vertical: 6),
            padding: const EdgeInsets.all(12),
            constraints: BoxConstraints(maxWidth: MediaQuery.of(context).size.width * 0.8),
            decoration: BoxDecoration(gradient: AppColors.brandGradient, borderRadius: BorderRadius.circular(AppRadii.lg)),
            child: Text(item.text, style: const TextStyle(color: Colors.white)),
          ),
        );
      case 'text':
        return Padding(
          padding: const EdgeInsets.symmetric(vertical: 6),
          child: MarkdownBody(
            data: item.text,
            selectable: true,
            styleSheet: MarkdownStyleSheet.fromTheme(Theme.of(context)).copyWith(
              p: const TextStyle(color: AppColors.textPrimary, fontSize: 15, height: 1.4),
            ),
          ),
        );
      case 'tool':
        final (label, icon) = _toolLabels[item.detail] ?? (item.detail ?? 'Tool', Icons.build_outlined);
        return Padding(
          padding: const EdgeInsets.symmetric(vertical: 2),
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Icon(icon, size: 15, color: item.ok ? AppColors.textMuted : Colors.redAccent),
              const SizedBox(width: 8),
              Expanded(
                child: Text.rich(
                  TextSpan(children: [
                    TextSpan(text: '$label ', style: const TextStyle(color: AppColors.textSecondary, fontWeight: FontWeight.w600)),
                    TextSpan(text: item.text, style: TextStyle(color: item.ok ? AppColors.textMuted : Colors.redAccent, fontFamily: 'monospace')),
                  ]),
                  style: const TextStyle(fontSize: 12.5),
                ),
              ),
            ],
          ),
        );
      case 'commit':
      case 'pr':
        final isPr = item.kind == 'pr';
        return Container(
          margin: const EdgeInsets.symmetric(vertical: 6),
          decoration: BoxDecoration(
            color: AppColors.surface,
            borderRadius: BorderRadius.circular(AppRadii.md),
            border: Border.all(color: Colors.greenAccent.withValues(alpha: 0.35)),
          ),
          child: ListTile(
            dense: true,
            leading: Icon(isPr ? Icons.merge_type_rounded : Icons.commit_rounded, color: Colors.greenAccent),
            title: Text(item.text, style: const TextStyle(color: AppColors.textPrimary, fontWeight: FontWeight.w600)),
            subtitle: item.detail == null
                ? null
                : Text(item.detail!, style: const TextStyle(color: AppColors.textMuted, fontFamily: 'monospace', fontSize: 12)),
            trailing: item.url == null ? null : const Icon(Icons.open_in_new_rounded, size: 18, color: AppColors.textMuted),
            onTap: () => _open(item.url),
          ),
        );
      case 'error':
        return Container(
          margin: const EdgeInsets.symmetric(vertical: 6),
          padding: const EdgeInsets.all(12),
          decoration: BoxDecoration(
            color: Colors.red.withValues(alpha: 0.12),
            borderRadius: BorderRadius.circular(AppRadii.md),
            border: Border.all(color: Colors.redAccent.withValues(alpha: 0.4)),
          ),
          child: Text(item.text, style: const TextStyle(color: AppColors.textPrimary)),
        );
      default:
        return Padding(
          padding: const EdgeInsets.symmetric(vertical: 4),
          child: Text(item.text, style: const TextStyle(color: AppColors.textMuted, fontStyle: FontStyle.italic)),
        );
    }
  }
}
