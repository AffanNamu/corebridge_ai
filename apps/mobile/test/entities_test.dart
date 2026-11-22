import 'package:corebridge_mobile/domain/entities/agent_session.dart';
import 'package:corebridge_mobile/domain/entities/message_entity.dart';
import 'package:corebridge_mobile/domain/entities/user_api_keys.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  group('UserApiKeys', () {
    test('ARO needs no key and uses the ARO model', () {
      const keys = UserApiKeys();
      expect(UserApiKeys.requiresKey('aro'), isFalse);
      expect(UserApiKeys.requiresKey('claude'), isTrue);
      expect(keys.modelFor('aro'), 'aro-1.5');
    });

    test('Qwen images use the detected vision model', () {
      const keys = UserApiKeys(qwenModel: 'qwen3-max', qwenVisionModel: 'qwen-vl-plus');
      expect(keys.modelFor('qwen'), 'qwen3-max');
      expect(keys.modelFor('qwen', hasImages: true), 'qwen-vl-plus');
      expect(const UserApiKeys().modelFor('qwen', hasImages: true), 'qwen-vl-max');
    });

    test('round-trips GitHub connection', () {
      final keys = UserApiKeys.fromMap(const UserApiKeys(github: 'github_pat_x', githubLogin: 'me').toMap());
      expect(keys.hasGitHub, isTrue);
      expect(keys.githubLogin, 'me');
      expect(keys.copyWith(github: '').hasGitHub, isFalse);
    });
  });

  test('MessageEntity keeps who answered and the feedback', () {
    final message = MessageEntity(
      id: 'm1',
      conversationId: 'c1',
      role: MessageRole.assistant,
      content: 'hi',
      createdAt: DateTime.fromMillisecondsSinceEpoch(1000),
      provider: 'aro',
      servedBy: 'aro',
      model: 'aro-1.5',
      rating: -1,
      correction: 'better',
    );
    final back = MessageEntity.fromMap('m1', 'c1', message.toMap());
    expect(back, message);
    expect(message.copyWith(id: 'm2').id, 'm2');
  });

  test('AgentSession round-trips and caps the timeline', () {
    final items = List.generate(
      AgentSession.maxTimelineItems + 10,
      (i) => AgentTimelineItem(kind: 'tool', text: 'step $i', detail: 'read_file', at: DateTime.fromMillisecondsSinceEpoch(i)),
    );
    final session = AgentSession(
      id: 's1',
      ownerId: 'u1',
      repoOwner: 'acme',
      repoName: 'app',
      title: 'Fix it',
      baseBranch: 'main',
      workBranch: 'aro/fix-it-abc12',
      pushMode: 'branch',
      status: 'paused',
      stateJson: '{"version":1}',
      timeline: items,
      commitCount: 2,
      createdAt: DateTime.fromMillisecondsSinceEpoch(1),
      updatedAt: DateTime.fromMillisecondsSinceEpoch(2),
    );
    final map = session.toMap();
    expect(map['repoFullName'], 'acme/app');
    final back = AgentSession.fromMap('s1', map);
    expect(back.timeline.length, AgentSession.maxTimelineItems);
    expect(back.timeline.last.text, 'step ${items.length - 1}');
    expect(back.workBranch, 'aro/fix-it-abc12');
    expect(back.commitCount, 2);
  });
}
