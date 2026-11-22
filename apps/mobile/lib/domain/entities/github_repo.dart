import 'package:equatable/equatable.dart';

/// A GitHub repository the user's token can see.
class GitHubRepo extends Equatable {
  final String owner;
  final String name;
  final String defaultBranch;
  final bool isPrivate;
  final bool canPush;
  final String? description;
  final DateTime? pushedAt;

  const GitHubRepo({
    required this.owner,
    required this.name,
    required this.defaultBranch,
    required this.isPrivate,
    required this.canPush,
    this.description,
    this.pushedAt,
  });

  String get fullName => '$owner/$name';

  factory GitHubRepo.fromApi(Map<String, dynamic> json) {
    return GitHubRepo(
      owner: (json['owner'] as Map<String, dynamic>)['login'] as String,
      name: json['name'] as String,
      defaultBranch: (json['default_branch'] as String?) ?? 'main',
      isPrivate: (json['private'] as bool?) ?? false,
      canPush: ((json['permissions'] as Map<String, dynamic>?)?['push'] as bool?) ?? false,
      description: json['description'] as String?,
      pushedAt: DateTime.tryParse((json['pushed_at'] as String?) ?? ''),
    );
  }

  @override
  List<Object?> get props => [owner, name, defaultBranch, isPrivate, canPush, description, pushedAt];
}
