import 'dart:convert';
import 'dart:io';

import 'package:firebase_auth/firebase_auth.dart';

/// Calls the aro-knowledge Edge Function: the user's Knowledge Base documents
/// and long-term memory. Every call is scoped to the signed-in user.
class KnowledgeClient {
  final String supabaseFunctionsBaseUrl;

  KnowledgeClient(this.supabaseFunctionsBaseUrl);

  Future<Map<String, dynamic>> call(String action, [Map<String, dynamic> payload = const {}]) async {
    if (supabaseFunctionsBaseUrl.trim().isEmpty) {
      throw StateError('App was built without SUPABASE_FUNCTIONS_URL. Rebuild with the correct --dart-define.');
    }
    final user = FirebaseAuth.instance.currentUser;
    if (user == null) throw StateError('Sign in first.');
    final client = HttpClient();
    try {
      final request = await client.postUrl(Uri.parse('$supabaseFunctionsBaseUrl/aro-knowledge'));
      request.headers.contentType = ContentType('application', 'json', charset: 'utf-8');
      request.headers.set('Authorization', 'Bearer ${await user.getIdToken()}');
      request.add(utf8.encode(jsonEncode({'action': action, ...payload})));
      final response = await request.close();
      final body = await response.transform(utf8.decoder).join();
      Map<String, dynamic> decoded;
      try {
        decoded = jsonDecode(body) as Map<String, dynamic>;
      } catch (_) {
        decoded = {};
      }
      if (response.statusCode != 200) {
        throw HttpException(decoded['error'] as String? ?? 'Request failed (${response.statusCode})');
      }
      return decoded;
    } finally {
      client.close(force: true);
    }
  }

  Future<List<Map<String, dynamic>>> listDocuments() async =>
      ((await call('kb_list'))['documents'] as List? ?? const []).map((e) => Map<String, dynamic>.from(e as Map)).toList();

  Future<Map<String, dynamic>> addFile(String filename, List<int> bytes) =>
      call('kb_add', {'filename': filename, 'data': base64Encode(bytes)});

  Future<Map<String, dynamic>> addText(String title, String text) => call('kb_add', {'title': title, 'text': text});

  Future<void> deleteDocument(String id) => call('kb_delete', {'id': id});

  Future<Map<String, dynamic>> memory() => call('memory_list');
  Future<void> setMemoryEnabled(bool enabled) => call('memory_set', {'enabled': enabled});
  Future<void> addMemory(String content) => call('memory_add', {'content': content});
  Future<void> deleteMemory(String id) => call('memory_delete', {'id': id});
  Future<void> clearMemory() => call('memory_clear');
}
