import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/di/providers.dart';
import '../../core/theme/app_theme.dart';

/// Long-term memory: OFF unless the user turns it on. Shows everything ARO
/// remembers, with add, delete and delete-all.
class MemoryScreen extends ConsumerStatefulWidget {
  const MemoryScreen({super.key});

  @override
  ConsumerState<MemoryScreen> createState() => _MemoryScreenState();
}

class _MemoryScreenState extends ConsumerState<MemoryScreen> {
  bool? _enabled;
  List<Map<String, dynamic>> _memories = const [];
  String? _error;

  @override
  void initState() {
    super.initState();
    _load();
  }

  String _friendly(Object e) => e.toString().replaceFirst('HttpException: ', '').replaceFirst('StateError: ', '');
  void _snack(String text) => ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(text)));

  Future<void> _load() async {
    try {
      final r = await ref.read(knowledgeClientProvider).memory();
      if (!mounted) return;
      setState(() {
        _enabled = r['enabled'] == true;
        _memories = ((r['memories'] as List?) ?? const []).map((e) => Map<String, dynamic>.from(e as Map)).toList();
        _error = null;
      });
    } catch (e) {
      if (mounted) setState(() => _error = _friendly(e));
    }
  }

  Future<void> _toggle(bool value) async {
    try {
      await ref.read(knowledgeClientProvider).setMemoryEnabled(value);
      await _load();
    } catch (e) {
      _snack(_friendly(e));
    }
  }

  Future<void> _add() async {
    final controller = TextEditingController();
    final ok = await showDialog<bool>(
      context: context,
      builder: (c) => AlertDialog(
        backgroundColor: AppColors.surfaceRaised,
        title: const Text('Add a memory'),
        content: TextField(controller: controller, maxLength: 300, decoration: const InputDecoration(hintText: 'e.g. Prefers answers in Hausa')),
        actions: [
          TextButton(onPressed: () => Navigator.pop(c, false), child: const Text('Cancel')),
          FilledButton(onPressed: () => Navigator.pop(c, true), child: const Text('Save')),
        ],
      ),
    );
    if (ok != true || controller.text.trim().length < 3) return;
    try {
      await ref.read(knowledgeClientProvider).addMemory(controller.text.trim());
      await _load();
    } catch (e) {
      _snack(_friendly(e));
    }
  }

  Future<void> _delete(String id) async {
    try {
      await ref.read(knowledgeClientProvider).deleteMemory(id);
      await _load();
    } catch (e) {
      _snack(_friendly(e));
    }
  }

  Future<void> _clear() async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (c) => AlertDialog(
        backgroundColor: AppColors.surfaceRaised,
        title: const Text('Delete all memories?'),
        content: const Text('ARO will forget everything listed here. This can\'t be undone.'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(c, false), child: const Text('Cancel')),
          FilledButton(onPressed: () => Navigator.pop(c, true), child: const Text('Delete all')),
        ],
      ),
    );
    if (ok != true) return;
    try {
      await ref.read(knowledgeClientProvider).clearMemory();
      await _load();
    } catch (e) {
      _snack(_friendly(e));
    }
  }

  @override
  Widget build(BuildContext context) {
    final enabled = _enabled;
    return Scaffold(
      appBar: AppBar(
        title: const Text('Memory'),
        actions: [
          if (_memories.isNotEmpty) IconButton(icon: const Icon(Icons.delete_sweep_outlined), tooltip: 'Delete all', onPressed: _clear),
        ],
      ),
      floatingActionButton: enabled == true
          ? FloatingActionButton(onPressed: _add, tooltip: 'Add a memory', child: const Icon(Icons.add_rounded))
          : null,
      body: RefreshIndicator(
        onRefresh: _load,
        child: ListView(
          padding: const EdgeInsets.fromLTRB(16, 12, 16, 96),
          children: [
            SwitchListTile(
              contentPadding: EdgeInsets.zero,
              value: enabled ?? false,
              activeThumbColor: AppColors.accentBlue,
              onChanged: enabled == null ? null : _toggle,
              title: const Text('Let ARO remember things about me', style: TextStyle(color: AppColors.textPrimary)),
              subtitle: const Text(
                'When on, ARO keeps short notes from what you tell it — like your name, work, language or how you like answers — '
                'and uses them in later chats. Say "remember that…" or "forget…" any time. Health, religion, politics, money '
                'and ID details are not saved automatically. Only you can see these.',
                style: TextStyle(color: AppColors.textMuted, fontSize: 12, height: 1.35),
              ),
            ),
            if (_error != null) Padding(padding: const EdgeInsets.all(12), child: Text(_error!, style: const TextStyle(color: Colors.redAccent))),
            if (enabled == null && _error == null) const Padding(padding: EdgeInsets.all(32), child: Center(child: CircularProgressIndicator())),
            if (enabled == false && _memories.isNotEmpty)
              const Padding(
                padding: EdgeInsets.symmetric(vertical: 8),
                child: Text('Memory is off: these are kept but not used. Delete them if you no longer want them.',
                    style: TextStyle(color: AppColors.textSecondary, fontSize: 13)),
              ),
            if (enabled != null && _memories.isEmpty)
              const Padding(
                padding: EdgeInsets.all(24),
                child: Center(child: Text('Nothing remembered yet.', style: TextStyle(color: AppColors.textMuted))),
              ),
            for (final m in _memories)
              Card(
                color: AppColors.surface,
                child: ListTile(
                  leading: Icon(
                    switch (m['kind']) { 'rule' => Icons.rule_rounded, 'preference' => Icons.favorite_border_rounded, _ => Icons.info_outline_rounded },
                    color: AppColors.accentBlue,
                  ),
                  title: Text('${m['content']}'),
                  subtitle: Text(
                    switch (m['source']) { 'explicit' => 'You asked ARO to remember', 'manual' => 'Added by you', _ => 'Noticed from your chat' },
                    style: const TextStyle(color: AppColors.textMuted, fontSize: 12),
                  ),
                  trailing: IconButton(icon: const Icon(Icons.close_rounded), tooltip: 'Forget this', onPressed: () => _delete(m['id'] as String)),
                ),
              ),
          ],
        ),
      ),
    );
  }
}
