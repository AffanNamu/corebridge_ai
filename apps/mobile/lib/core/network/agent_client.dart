import 'dart:convert';
import 'dart:io';

import 'package:firebase_auth/firebase_auth.dart';

import '../../domain/entities/agent_session.dart';
import '../utils/cancel_token.dart';

/// Streams a run of the aro-agent Edge Function (the GitHub coding agent).
class AgentClient {
  final String supabaseFunctionsBaseUrl;

  AgentClient(this.supabaseFunctionsBaseUrl);

  Stream<AgentEvent> run({
    required String provider,
    required String model,
    required String apiKey,
    required String githubToken,
    required String repoOwner,
    required String repoName,
    String? baseBranch,
    String pushMode = 'branch',
    String? message,
    bool continueRun = false,
    Map<String, dynamic>? state,
    CancelToken? cancelToken,
  }) async* {
    if (supabaseFunctionsBaseUrl.trim().isEmpty) {
      throw StateError('App was built without SUPABASE_FUNCTIONS_URL. Rebuild with the correct --dart-define.');
    }
    final user = FirebaseAuth.instance.currentUser;
    if (user == null) throw StateError('Sign in first.');

    final client = HttpClient();
    var cancelled = false;
    cancelToken?.onCancel(() {
      cancelled = true;
      client.close(force: true);
    });

    try {
      final idToken = await user.getIdToken();
      final request = await client.postUrl(Uri.parse('$supabaseFunctionsBaseUrl/aro-agent'));
      request.headers.contentType = ContentType('application', 'json', charset: 'utf-8');
      request.headers.set('Authorization', 'Bearer $idToken');
      request.add(utf8.encode(jsonEncode({
        'provider': provider,
        'model': model,
        'apiKey': apiKey,
        'githubToken': githubToken,
        'repo': {'owner': repoOwner, 'name': repoName},
        if (baseBranch != null) 'baseBranch': baseBranch,
        'pushMode': pushMode,
        if (message != null && message.trim().isNotEmpty) 'message': message.trim(),
        if (continueRun) 'continue': true,
        if (state != null) 'state': state,
      })));

      final response = await request.close();
      if (response.statusCode != 200) {
        final body = await response.transform(utf8.decoder).join();
        String error = 'Agent error (${response.statusCode})';
        try {
          error = (jsonDecode(body) as Map<String, dynamic>)['error'] as String? ?? error;
        } catch (_) {}
        throw HttpException(error);
      }

      var buffer = '';
      await for (final chunk in response.transform(utf8.decoder)) {
        if (cancelled) return;
        buffer += chunk;
        final lines = buffer.split('\n');
        buffer = lines.removeLast();
        for (final line in lines) {
          final trimmed = line.trim();
          if (!trimmed.startsWith('data:')) continue;
          final payload = trimmed.substring(5).trim();
          if (payload.isEmpty || payload == '[DONE]') continue;
          try {
            final decoded = jsonDecode(payload) as Map<String, dynamic>;
            yield AgentEvent(decoded['type'] as String? ?? 'status', decoded);
          } on FormatException {
            continue;
          }
        }
      }
    } catch (e) {
      if (cancelled || cancelToken?.isCancelled == true) return;
      rethrow;
    } finally {
      client.close(force: true);
    }
  }
}
