import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../core/di/providers.dart';
import '../../core/theme/app_theme.dart';
import '../../data/remote/github/github_api.dart';
import '../../domain/entities/github_repo.dart';
import '../../domain/entities/user_api_keys.dart';
import '../widgets/model_selector_bar.dart';

/// "Code": connect GitHub, then pick a repository to work in with the
/// ARO coding agent.
class CodeScreen extends ConsumerStatefulWidget {
  const CodeScreen({super.key});

  @override
  ConsumerState<CodeScreen> createState() => _CodeScreenState();
}

class _CodeScreenState extends ConsumerState<CodeScreen> {
  static final _tokenPage = Uri.parse('https://github.com/settings/personal-access-tokens/new');

  UserApiKeys _keys = const UserApiKeys();
  List<GitHubRepo> _repos = const [];
  String _query = '';
  bool _loading = true;
  bool _connecting = false;
  String? _error;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    final uid = ref.read(firebaseServiceProvider).currentUserId;
    if (uid == null) return;
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final keys = await ref.read(userSettingsRepositoryProvider).getApiKeys(uid);
      var repos = const <GitHubRepo>[];
      if (keys.hasGitHub) repos = await ref.read(gitHubApiProvider).listRepos(keys.github!);
      if (!mounted) return;
      setState(() {
        _keys = keys;
        _repos = repos;
      });
    } on GitHubApiException catch (e) {
      if (mounted) setState(() => _error = e.message);
    } catch (e) {
      if (mounted) setState(() => _error = e.toString());
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  Future<void> _connect(String token) async {
    final uid = ref.read(firebaseServiceProvider).currentUserId;
    if (uid == null || token.trim().isEmpty) return;
    setState(() {
      _connecting = true;
      _error = null;
    });
    try {
      final login = await ref.read(gitHubApiProvider).viewerLogin(token.trim());
      final updated = _keys.copyWith(github: token.trim(), githubLogin: login);
      await ref.read(userSettingsRepositoryProvider).saveApiKeys(uid, updated);
      if (!mounted) return;
      setState(() => _keys = updated);
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('Connected to GitHub as @$login')));
      await _load();
    } on GitHubApiException catch (e) {
      if (mounted) setState(() => _error = e.message);
    } finally {
      if (mounted) setState(() => _connecting = false);
    }
  }

  Future<void> _disconnect() async {
    final uid = ref.read(firebaseServiceProvider).currentUserId;
    if (uid == null) return;
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        backgroundColor: AppColors.surfaceRaised,
        title: const Text('Disconnect GitHub?'),
        content: const Text('ARO will no longer be able to read or push to your repositories. You can also revoke the token on GitHub.'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(dialogContext, false), child: const Text('Cancel')),
          TextButton(
            onPressed: () => Navigator.pop(dialogContext, true),
            child: const Text('Disconnect', style: TextStyle(color: Colors.redAccent)),
          ),
        ],
      ),
    );
    if (confirmed != true) return;
    final updated = _keys.copyWith(github: '', githubLogin: '');
    await ref.read(userSettingsRepositoryProvider).saveApiKeys(uid, updated);
    if (mounted) {
      setState(() {
        _keys = updated;
        _repos = const [];
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: Column(
        children: [
          const ModelSelectorBar(),
          Expanded(
            child: _loading
                ? const Center(child: CircularProgressIndicator(color: AppColors.accentBlue))
                : _keys.hasGitHub
                    ? _buildRepoList()
                    : _ConnectGitHubCard(
                        connecting: _connecting,
                        error: _error,
                        onConnect: _connect,
                        onOpenTokenPage: () => launchUrl(_tokenPage, mode: LaunchMode.externalApplication),
                      ),
          ),
        ],
      ),
    );
  }

  Widget _buildRepoList() {
    final q = _query.toLowerCase();
    final repos = q.isEmpty ? _repos : _repos.where((r) => r.fullName.toLowerCase().contains(q)).toList();

    return RefreshIndicator(
      onRefresh: _load,
      child: ListView(
        padding: const EdgeInsets.fromLTRB(20, 8, 20, 24),
        children: [
          Text('Code', style: Theme.of(context).textTheme.headlineMedium),
          const SizedBox(height: 4),
          Text(
            'Pick a repository. ARO reads the code, makes the fix and pushes it to GitHub for you.',
            style: Theme.of(context).textTheme.bodyMedium,
          ),
          const SizedBox(height: 12),
          Row(
            children: [
              const Icon(Icons.check_circle_rounded, color: Colors.greenAccent, size: 16),
              const SizedBox(width: 6),
              Expanded(
                child: Text(
                  'Connected as @${_keys.githubLogin ?? ''}',
                  style: const TextStyle(color: AppColors.textSecondary, fontSize: 13),
                ),
              ),
              TextButton(onPressed: _disconnect, child: const Text('Disconnect')),
            ],
          ),
          const SizedBox(height: 8),
          TextField(
            onChanged: (v) => setState(() => _query = v),
            style: const TextStyle(color: AppColors.textPrimary),
            decoration: const InputDecoration(
              hintText: 'Search repositories',
              prefixIcon: Icon(Icons.search_rounded, color: AppColors.textMuted),
            ),
          ),
          const SizedBox(height: 12),
          if (_error != null)
            Padding(
              padding: const EdgeInsets.only(bottom: 12),
              child: Text(_error!, style: const TextStyle(color: Colors.redAccent)),
            ),
          if (repos.isEmpty)
            Padding(
              padding: const EdgeInsets.symmetric(vertical: 24),
              child: Text(
                _repos.isEmpty
                    ? 'No repositories found. Make sure your token has access to the repos you want ARO to work on.'
                    : 'No repositories match "$_query".',
                style: Theme.of(context).textTheme.bodyMedium,
              ),
            ),
          ...repos.map(_repoTile),
        ],
      ),
    );
  }

  Widget _repoTile(GitHubRepo repo) {
    return Container(
      margin: const EdgeInsets.only(bottom: 10),
      decoration: BoxDecoration(
        color: AppColors.surface,
        borderRadius: BorderRadius.circular(AppRadii.lg),
        border: Border.all(color: AppColors.border),
      ),
      child: ListTile(
        contentPadding: const EdgeInsets.symmetric(horizontal: 14, vertical: 4),
        leading: Icon(repo.isPrivate ? Icons.lock_outline_rounded : Icons.public_rounded, color: AppColors.textMuted, size: 20),
        title: Text(repo.fullName, style: const TextStyle(color: AppColors.textPrimary, fontWeight: FontWeight.w600)),
        subtitle: Text(
          [
            if (repo.description?.isNotEmpty == true) repo.description!,
            repo.canPush ? 'branch: ${repo.defaultBranch}' : 'read-only — your token can\'t push here',
          ].join(' · '),
          maxLines: 2,
          overflow: TextOverflow.ellipsis,
          style: const TextStyle(color: AppColors.textMuted, fontSize: 12),
        ),
        trailing: const Icon(Icons.chevron_right_rounded, color: AppColors.textMuted),
        onTap: () => context.push('/code/repo', extra: repo),
      ),
    );
  }
}

class _ConnectGitHubCard extends StatefulWidget {
  final bool connecting;
  final String? error;
  final void Function(String token) onConnect;
  final VoidCallback onOpenTokenPage;

  const _ConnectGitHubCard({
    required this.connecting,
    required this.error,
    required this.onConnect,
    required this.onOpenTokenPage,
  });

  @override
  State<_ConnectGitHubCard> createState() => _ConnectGitHubCardState();
}

class _ConnectGitHubCardState extends State<_ConnectGitHubCard> {
  final _controller = TextEditingController();

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    const steps = [
      'Open GitHub → Fine-grained token (button below).',
      'Repository access: choose the repos ARO may work on.',
      'Permissions: Contents → Read and write, Pull requests → Read and write. Optional: Actions → Read (lets ARO see CI results).',
      'Generate the token, copy it, and paste it here.',
    ];
    return ListView(
      padding: const EdgeInsets.fromLTRB(20, 8, 20, 24),
      children: [
        Text('Connect GitHub', style: Theme.of(context).textTheme.headlineMedium),
        const SizedBox(height: 6),
        Text(
          'ARO works directly in your repositories: it reads the code, fixes problems and pushes the changes for you.',
          style: Theme.of(context).textTheme.bodyMedium,
        ),
        const SizedBox(height: 20),
        for (final (index, step) in steps.indexed)
          Padding(
            padding: const EdgeInsets.only(bottom: 10),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                CircleAvatar(
                  radius: 11,
                  backgroundColor: AppColors.accentBlue.withValues(alpha: 0.2),
                  child: Text('${index + 1}', style: const TextStyle(color: AppColors.accentBlue, fontSize: 12)),
                ),
                const SizedBox(width: 10),
                Expanded(child: Text(step, style: const TextStyle(color: AppColors.textSecondary))),
              ],
            ),
          ),
        const SizedBox(height: 6),
        OutlinedButton.icon(
          onPressed: widget.onOpenTokenPage,
          icon: const Icon(Icons.open_in_new_rounded, size: 18),
          label: const Text('Create a token on GitHub'),
        ),
        const SizedBox(height: 16),
        TextField(
          controller: _controller,
          obscureText: true,
          style: const TextStyle(color: AppColors.textPrimary),
          decoration: const InputDecoration(hintText: 'Paste your token (github_pat_…)'),
        ),
        if (widget.error != null)
          Padding(
            padding: const EdgeInsets.only(top: 8),
            child: Text(widget.error!, style: const TextStyle(color: Colors.redAccent)),
          ),
        const SizedBox(height: 12),
        FilledButton(
          onPressed: widget.connecting ? null : () => widget.onConnect(_controller.text),
          child: widget.connecting
              ? const SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2))
              : const Text('Connect'),
        ),
        const SizedBox(height: 16),
        const Text(
          'Your token is stored in your private profile and is only sent to GitHub through ARO AI\'s agent. Revoke it on GitHub at any time.',
          style: TextStyle(color: AppColors.textMuted, fontSize: 12),
        ),
      ],
    );
  }
}
