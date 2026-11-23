import 'package:file_picker/file_picker.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/di/providers.dart';
import '../../core/theme/app_theme.dart';

/// The user's own documents. ARO searches them for every chat message and
/// cites what it uses ([K1], [K2]…); "Docs only" in the chat bar makes it
/// answer only from them.
class KnowledgeBaseScreen extends ConsumerStatefulWidget {
  const KnowledgeBaseScreen({super.key});

  @override
  ConsumerState<KnowledgeBaseScreen> createState() => _KnowledgeBaseScreenState();
}

class _KnowledgeBaseScreenState extends ConsumerState<KnowledgeBaseScreen> {
  static const _extensions = [
    'pdf', 'docx', 'txt', 'md', 'markdown', 'csv', 'tsv', 'json', 'html', 'xml', 'yaml', 'yml',
    'js', 'ts', 'py', 'dart', 'java', 'kt', 'go', 'rs', 'rb', 'php', 'c', 'cpp', 'cs', 'sql', 'sh',
  ];

  List<Map<String, dynamic>>? _documents;
  String? _error;
  String? _busy;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    try {
      final docs = await ref.read(knowledgeClientProvider).listDocuments();
      if (!mounted) return;
      setState(() {
        _documents = docs;
        _error = null;
      });
    } catch (e) {
      if (mounted) setState(() => _error = _friendly(e));
    }
  }

  String _friendly(Object e) => e.toString().replaceFirst('HttpException: ', '').replaceFirst('StateError: ', '');

  void _snack(String text) => ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(text)));

  Future<void> _upload() async {
    final picked = await FilePicker.platform.pickFiles(type: FileType.custom, allowedExtensions: _extensions, withData: true);
    final file = picked?.files.single;
    if (file == null || file.bytes == null) return;
    if (file.size > 10 * 1024 * 1024) {
      _snack('Files can be up to 10 MB.');
      return;
    }
    setState(() => _busy = 'Reading ${file.name}…');
    try {
      final r = await ref.read(knowledgeClientProvider).addFile(file.name, file.bytes!);
      _snack('Added "${r['title']}" (${r['chunks']} passage${r['chunks'] == 1 ? '' : 's'}).');
      await _load();
    } catch (e) {
      _snack(_friendly(e));
    } finally {
      if (mounted) setState(() => _busy = null);
    }
  }

  Future<void> _paste() async {
    final title = TextEditingController();
    final text = TextEditingController();
    final ok = await showDialog<bool>(
      context: context,
      builder: (c) => AlertDialog(
        backgroundColor: AppColors.surfaceRaised,
        title: const Text('Paste text'),
        content: SizedBox(
          width: 480,
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              TextField(controller: title, decoration: const InputDecoration(labelText: 'Title')),
              const SizedBox(height: 12),
              TextField(controller: text, minLines: 6, maxLines: 12, decoration: const InputDecoration(labelText: 'Text', alignLabelWithHint: true)),
            ],
          ),
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(c, false), child: const Text('Cancel')),
          FilledButton(onPressed: () => Navigator.pop(c, true), child: const Text('Add')),
        ],
      ),
    );
    if (ok != true || text.text.trim().isEmpty) return;
    setState(() => _busy = 'Adding…');
    try {
      await ref.read(knowledgeClientProvider).addText(title.text.trim(), text.text);
      await _load();
    } catch (e) {
      _snack(_friendly(e));
    } finally {
      if (mounted) setState(() => _busy = null);
    }
  }

  Future<void> _delete(Map<String, dynamic> doc) async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (c) => AlertDialog(
        backgroundColor: AppColors.surfaceRaised,
        title: Text('Delete "${doc['title']}"?'),
        content: const Text('ARO will no longer use it in answers.'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(c, false), child: const Text('Cancel')),
          FilledButton(onPressed: () => Navigator.pop(c, true), child: const Text('Delete')),
        ],
      ),
    );
    if (ok != true) return;
    try {
      await ref.read(knowledgeClientProvider).deleteDocument(doc['id'] as String);
      await _load();
    } catch (e) {
      _snack(_friendly(e));
    }
  }

  IconData _icon(String? kind) => switch (kind) {
        'pdf' => Icons.picture_as_pdf_outlined,
        'docx' => Icons.description_outlined,
        'code' => Icons.code_rounded,
        'csv' => Icons.table_chart_outlined,
        _ => Icons.article_outlined,
      };

  @override
  Widget build(BuildContext context) {
    final docs = _documents;
    return Scaffold(
      appBar: AppBar(
        title: const Text('Knowledge Base'),
        actions: [IconButton(icon: const Icon(Icons.content_paste_rounded), tooltip: 'Paste text', onPressed: _busy == null ? _paste : null)],
      ),
      floatingActionButton: FloatingActionButton.extended(
        onPressed: _busy == null ? _upload : null,
        icon: const Icon(Icons.upload_file_rounded),
        label: const Text('Add file'),
      ),
      body: RefreshIndicator(
        onRefresh: _load,
        child: ListView(
          padding: const EdgeInsets.fromLTRB(16, 12, 16, 96),
          children: [
            const Text(
              'ARO searches these documents for every chat message and cites what it uses, like [K1]. '
              'Turn on "Docs only" in the chat bar to get answers only from your documents — ARO will say so '
              'instead of guessing when they don\'t cover it. Only you can see them.',
              style: TextStyle(color: AppColors.textSecondary, fontSize: 13, height: 1.4),
            ),
            const SizedBox(height: 4),
            const Text('PDF (with a text layer), Word .docx, text, Markdown, CSV, JSON and code files, up to 10 MB.',
                style: TextStyle(color: AppColors.textMuted, fontSize: 12)),
            const SizedBox(height: 12),
            if (_busy != null) ...[const LinearProgressIndicator(), const SizedBox(height: 4), Text(_busy!, style: const TextStyle(color: AppColors.textMuted))],
            if (_error != null) Padding(padding: const EdgeInsets.all(12), child: Text(_error!, style: const TextStyle(color: Colors.redAccent))),
            if (docs == null && _error == null) const Padding(padding: EdgeInsets.all(32), child: Center(child: CircularProgressIndicator())),
            if (docs != null && docs.isEmpty)
              const Padding(
                padding: EdgeInsets.all(32),
                child: Center(child: Text('No documents yet. Add a file or paste text.', style: TextStyle(color: AppColors.textMuted))),
              ),
            for (final doc in docs ?? const <Map<String, dynamic>>[])
              Card(
                color: AppColors.surface,
                child: ListTile(
                  leading: Icon(_icon(doc['kind'] as String?), color: AppColors.accentBlue),
                  title: Text('${doc['title']}', maxLines: 1, overflow: TextOverflow.ellipsis),
                  subtitle: Text(
                    '${doc['chunks']} passage${doc['chunks'] == 1 ? '' : 's'} · ${((doc['chars'] as num? ?? 0) / 1000).toStringAsFixed(1)}k characters'
                    '${doc['embedded'] == true ? ' · semantic search' : ''}',
                    style: const TextStyle(color: AppColors.textMuted, fontSize: 12),
                  ),
                  trailing: IconButton(icon: const Icon(Icons.delete_outline_rounded), tooltip: 'Delete', onPressed: () => _delete(doc)),
                ),
              ),
          ],
        ),
      ),
    );
  }
}
