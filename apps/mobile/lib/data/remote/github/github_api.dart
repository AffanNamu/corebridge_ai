import 'dart:convert';
import 'dart:io';

import '../../../domain/entities/github_repo.dart';

class GitHubApiException implements Exception {
  final int statusCode;
  final String message;
  const GitHubApiException(this.statusCode, this.message);

  @override
  String toString() => message;
}

/// Direct, read-only GitHub calls the app makes with the user's token:
/// check who the token belongs to, list repos and branches. Everything that
/// writes to a repo goes through the aro-agent Edge Function instead.
class GitHubApi {
  static const _base = 'https://api.github.com';

  Future<dynamic> _get(String token, String path) async {
    final client = HttpClient();
    try {
      final request = await client.getUrl(Uri.parse('$_base$path'));
      request.headers.set('Authorization', 'Bearer $token');
      request.headers.set('Accept', 'application/vnd.github+json');
      request.headers.set('X-GitHub-Api-Version', '2022-11-28');
      final response = await request.close();
      final body = await response.transform(utf8.decoder).join();
      if (response.statusCode == 401) {
        throw const GitHubApiException(401, 'This GitHub token is invalid or expired.');
      }
      if (response.statusCode != 200) {
        String message = 'GitHub error (${response.statusCode})';
        try {
          message = (jsonDecode(body) as Map<String, dynamic>)['message'] as String? ?? message;
        } catch (_) {}
        throw GitHubApiException(response.statusCode, message);
      }
      return jsonDecode(body);
    } on SocketException {
      throw const GitHubApiException(0, "Can't reach GitHub. Check your connection.");
    } finally {
      client.close(force: true);
    }
  }

  /// Returns the GitHub username the token belongs to.
  Future<String> viewerLogin(String token) async {
    final data = await _get(token, '/user') as Map<String, dynamic>;
    return data['login'] as String;
  }

  /// Repos the token can see, most recently pushed first (up to 300).
  Future<List<GitHubRepo>> listRepos(String token) async {
    final repos = <GitHubRepo>[];
    for (var page = 1; page <= 3; page++) {
      final data = await _get(
        token,
        '/user/repos?per_page=100&page=$page&sort=pushed&affiliation=owner,collaborator,organization_member',
      ) as List<dynamic>;
      repos.addAll(data.map((r) => GitHubRepo.fromApi(r as Map<String, dynamic>)));
      if (data.length < 100) break;
    }
    return repos;
  }

  Future<List<String>> listBranches(String token, String owner, String repo) async {
    final data = await _get(token, '/repos/$owner/$repo/branches?per_page=100') as List<dynamic>;
    return data.map((b) => (b as Map<String, dynamic>)['name'] as String).toList();
  }
}
