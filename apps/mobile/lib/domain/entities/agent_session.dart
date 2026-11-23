import 'dart:convert';

import 'package:equatable/equatable.dart';

/// One line in an agent session's activity timeline.
class AgentTimelineItem extends Equatable {
  /// 'user' | 'text' | 'tool' | 'commit' | 'pr' | 'status' | 'error'
  final String kind;
  final String text;

  /// Tool name, commit SHA or PR number — depends on [kind].
  final String? detail;
  final bool ok;
  final String? url;
  final DateTime at;

  const AgentTimelineItem({
    required this.kind,
    required this.text,
    this.detail,
    this.ok = true,
    this.url,
    required this.at,
  });

  factory AgentTimelineItem.fromMap(Map<String, dynamic> map) {
    return AgentTimelineItem(
      kind: map['kind'] as String? ?? 'status',
      text: map['text'] as String? ?? '',
      detail: map['detail'] as String?,
      ok: map['ok'] as bool? ?? true,
      url: map['url'] as String?,
      at: DateTime.fromMillisecondsSinceEpoch((map['at'] as num?)?.toInt() ?? 0),
    );
  }

  Map<String, dynamic> toMap() => {
        'kind': kind,
        'text': text,
        if (detail != null) 'detail': detail,
        'ok': ok,
        if (url != null) 'url': url,
        'at': at.millisecondsSinceEpoch,
      };

  AgentTimelineItem copyWith({bool? ok, String? text}) => AgentTimelineItem(
        kind: kind,
        text: text ?? this.text,
        detail: detail,
        ok: ok ?? this.ok,
        url: url,
        at: at,
      );

  @override
  List<Object?> get props => [kind, text, detail, ok, url, at];
}

/// A coding-agent session in one GitHub repo. [stateJson] is the opaque
/// state the aro-agent function returns; it's sent back to continue.
class AgentSession extends Equatable {
  final String id;
  final String ownerId;
  final String repoOwner;
  final String repoName;
  final String title;
  final String baseBranch;
  final String? workBranch;

  /// 'branch' (push to an aro/... branch) or 'direct' (push to [baseBranch]).
  final String pushMode;

  /// 'idle' | 'paused' | 'awaiting_confirmation' | 'error'
  final String status;
  final String? stateJson;
  final List<AgentTimelineItem> timeline;
  final int commitCount;
  final String? pullRequestUrl;
  final DateTime createdAt;
  final DateTime updatedAt;

  const AgentSession({
    required this.id,
    required this.ownerId,
    required this.repoOwner,
    required this.repoName,
    required this.title,
    required this.baseBranch,
    this.workBranch,
    required this.pushMode,
    this.status = 'idle',
    this.stateJson,
    this.timeline = const [],
    this.commitCount = 0,
    this.pullRequestUrl,
    required this.createdAt,
    required this.updatedAt,
  });

  factory AgentSession.fromMap(String id, Map<String, dynamic> map) {
    return AgentSession(
      id: id,
      ownerId: map['ownerId'] as String,
      repoOwner: map['repoOwner'] as String,
      repoName: map['repoName'] as String,
      title: map['title'] as String? ?? 'Task',
      baseBranch: map['baseBranch'] as String? ?? 'main',
      workBranch: map['workBranch'] as String?,
      pushMode: map['pushMode'] as String? ?? 'branch',
      status: map['status'] as String? ?? 'idle',
      stateJson: map['stateJson'] as String?,
      timeline: ((map['timeline'] as List?) ?? const [])
          .map((e) => AgentTimelineItem.fromMap(Map<String, dynamic>.from(e as Map)))
          .toList(),
      commitCount: (map['commitCount'] as num?)?.toInt() ?? 0,
      pullRequestUrl: map['pullRequestUrl'] as String?,
      createdAt: DateTime.fromMillisecondsSinceEpoch((map['createdAt'] as num).toInt()),
      updatedAt: DateTime.fromMillisecondsSinceEpoch((map['updatedAt'] as num).toInt()),
    );
  }

  /// Firestore documents max out at 1 MB, so only the latest items are kept.
  static const int maxTimelineItems = 400;

  Map<String, dynamic> toMap() {
    final items = timeline.length > maxTimelineItems
        ? timeline.sublist(timeline.length - maxTimelineItems)
        : timeline;
    return {
      'ownerId': ownerId,
      'repoOwner': repoOwner,
      'repoName': repoName,
      'repoFullName': '$repoOwner/$repoName',
      'title': title,
      'baseBranch': baseBranch,
      'workBranch': workBranch,
      'pushMode': pushMode,
      'status': status,
      'stateJson': stateJson,
      'timeline': items.map((e) => e.toMap()).toList(),
      'commitCount': commitCount,
      'pullRequestUrl': pullRequestUrl,
      'createdAt': createdAt.millisecondsSinceEpoch,
      'updatedAt': updatedAt.millisecondsSinceEpoch,
    };
  }

  AgentSession copyWith({
    String? id,
    String? workBranch,
    String? status,
    String? stateJson,
    List<AgentTimelineItem>? timeline,
    int? commitCount,
    String? pullRequestUrl,
    DateTime? updatedAt,
  }) {
    return AgentSession(
      id: id ?? this.id,
      ownerId: ownerId,
      repoOwner: repoOwner,
      repoName: repoName,
      title: title,
      baseBranch: baseBranch,
      workBranch: workBranch ?? this.workBranch,
      pushMode: pushMode,
      status: status ?? this.status,
      stateJson: stateJson ?? this.stateJson,
      timeline: timeline ?? this.timeline,
      commitCount: commitCount ?? this.commitCount,
      pullRequestUrl: pullRequestUrl ?? this.pullRequestUrl,
      createdAt: createdAt,
      updatedAt: updatedAt ?? this.updatedAt,
    );
  }

  /// The agent's plan for the current request, read from the saved state.
  AgentPlan? get plan {
    if (stateJson == null) return null;
    try {
      return AgentPlan.fromMap((jsonDecode(stateJson!) as Map<String, dynamic>)['plan']);
    } catch (_) {
      return null;
    }
  }

  /// The step waiting for the user's approval (status 'awaiting_confirmation'), read from the saved state.
  PendingApproval? get pendingApproval {
    if (status != 'awaiting_confirmation' || stateJson == null) return null;
    try {
      final run = (jsonDecode(stateJson!) as Map<String, dynamic>)['run'];
      if (run is! Map || run['phase'] != 'awaiting_confirmation') return null;
      return PendingApproval(
        id: run['callId'] as String? ?? '',
        tool: run['name'] as String? ?? '',
        summary: run['summary'] as String? ?? '',
        details: ((run['details'] as List?) ?? const []).map((e) => '$e').toList(),
      );
    } catch (_) {
      return null;
    }
  }

  @override
  List<Object?> get props => [id, repoOwner, repoName, status, stateJson, timeline, commitCount, pullRequestUrl, updatedAt];
}

/// The plan the agent writes before changing anything, kept up to date as it works.
class AgentPlan {
  final String goal;

  /// (title, status) with status 'pending' | 'in_progress' | 'done' | 'skipped'.
  final List<({String title, String status})> steps;
  const AgentPlan({required this.goal, required this.steps});

  int get done => steps.where((s) => s.status == 'done').length;

  static AgentPlan? fromMap(Object? raw) {
    if (raw is! Map) return null;
    final steps = ((raw['steps'] as List?) ?? const [])
        .whereType<Map>()
        .map((s) => (title: '${s['title'] ?? ''}', status: '${s['status'] ?? 'pending'}'))
        .where((s) => s.title.isNotEmpty)
        .toList();
    if (steps.isEmpty) return null;
    return AgentPlan(goal: '${raw['goal'] ?? ''}', steps: steps);
  }
}

/// A risky step (opening a pull request, pushing to the base branch, deleting
/// files, touching CI or secrets…) the agent won't take without approval.
class PendingApproval {
  final String id;
  final String tool;
  final String summary;
  final List<String> details;
  const PendingApproval({required this.id, required this.tool, required this.summary, this.details = const []});

  factory PendingApproval.fromEvent(Map<String, dynamic> data) => PendingApproval(
        id: data['id'] as String? ?? '',
        tool: data['tool'] as String? ?? '',
        summary: data['summary'] as String? ?? '',
        details: ((data['details'] as List?) ?? const []).map((e) => '$e').toList(),
      );
}

/// One event streamed by the aro-agent Edge Function.
class AgentEvent {
  final String type;
  final Map<String, dynamic> data;
  const AgentEvent(this.type, this.data);

  String get text => (data['text'] ?? data['message'] ?? data['summary'] ?? '') as String;
}
