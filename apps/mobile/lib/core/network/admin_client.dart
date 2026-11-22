import 'dart:convert';
import 'dart:io';

import 'package:firebase_auth/firebase_auth.dart';

/// Calls the aro-admin Edge Function. The server only accepts accounts
/// listed in its ADMIN_UIDS secret, so this is safe to ship in the app.
class AdminClient {
  final String supabaseFunctionsBaseUrl;

  AdminClient(this.supabaseFunctionsBaseUrl);

  Future<dynamic> call(String action, [Map<String, dynamic> params = const {}]) async {
    if (supabaseFunctionsBaseUrl.trim().isEmpty) {
      throw StateError('App was built without SUPABASE_FUNCTIONS_URL.');
    }
    final user = FirebaseAuth.instance.currentUser;
    if (user == null) throw StateError('Sign in first.');
    final idToken = await user.getIdToken();
    final client = HttpClient();
    try {
      final request = await client.postUrl(Uri.parse('$supabaseFunctionsBaseUrl/aro-admin'));
      request.headers.contentType = ContentType('application', 'json', charset: 'utf-8');
      request.headers.set('Authorization', 'Bearer $idToken');
      request.add(utf8.encode(jsonEncode({'action': action, ...params})));
      final response = await request.close();
      final body = await response.transform(utf8.decoder).join();
      final decoded = body.isEmpty ? null : jsonDecode(body);
      if (response.statusCode != 200) {
        final message = decoded is Map ? decoded['error'] : null;
        throw HttpException(message is String ? message : 'Admin error (${response.statusCode})');
      }
      return decoded;
    } finally {
      client.close(force: true);
    }
  }
}
