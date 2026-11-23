import '../../core/utils/cancel_token.dart';
import '../entities/ai_stream_event.dart';
import '../entities/chat_attachment.dart';
import '../entities/message_entity.dart';
import '../entities/user_api_keys.dart';
import '../repositories/conversation_repository.dart';
import '../repositories/user_settings_repository.dart';

class SendMessageUseCase {
  final ConversationRepository _conversationRepository;
  final UserSettingsRepository _userSettingsRepository;

  SendMessageUseCase(this._conversationRepository, this._userSettingsRepository);

  Stream<AiStreamEvent> call({
    required String uid,
    required String conversationId,
    required String userMessage,
    required List<MessageEntity> history,
    required String provider,
    // For provider 'aro': which ARO model ('auto', 'aro-code', ...).
    String? aroModel,
    List<ChatAttachment> attachments = const [],
    bool thinkingEnabled = false,
    bool webSearch = false,
    CancelToken? cancelToken,
  }) async* {
    if (provider == 'aro' && attachments.isNotEmpty && aroModel != 'auto' && aroModel != 'aro-vision') {
      throw StateError('This ARO model reads text only. Pick ARO Vision or ARO (Auto) to send images.');
    }

    final apiKeys = await _userSettingsRepository.getApiKeys(uid);
    // ARO 1.5 runs on ARO AI's own server — no user key involved.
    final apiKey = UserApiKeys.requiresKey(provider) ? apiKeys.forProvider(provider) : '';

    if (UserApiKeys.requiresKey(provider) && (apiKey == null || apiKey.trim().isEmpty)) {
      throw StateError('No API key set for $provider. Add one in Settings → AI Providers.');
    }

    final model = provider == 'aro'
        ? (aroModel ?? 'auto')
        : apiKeys.modelFor(provider, hasImages: attachments.isNotEmpty);

    await _conversationRepository.appendMessage(
      conversationId: conversationId,
      role: MessageRole.user,
      content: userMessage,
    );

    final historyMaps = history.map((m) => {'role': m.role.name, 'content': m.content}).toList();
    final contentBuffer = StringBuffer();
    final thinkingBuffer = StringBuffer();
    String servedBy = provider;
    String servedModel = model;

    await for (final event in _conversationRepository.streamAssistantReply(
      conversationId: conversationId,
      provider: provider,
      model: model,
      history: historyMaps,
      userMessage: userMessage,
      attachments: attachments,
      apiKey: apiKey ?? '',
      thinkingEnabled: thinkingEnabled,
      webSearch: webSearch,
      cancelToken: cancelToken,
    )) {
      switch (event.type) {
        case AiStreamEventType.content:
          contentBuffer.write(event.text);
        case AiStreamEventType.thinking:
          thinkingBuffer.write(event.text);
        case AiStreamEventType.meta:
          servedBy = event.servedBy ?? servedBy;
          servedModel = event.model ?? servedModel;
        case AiStreamEventType.saved:
          break;
      }
      yield event;
    }

    if (contentBuffer.isNotEmpty) {
      final saved = await _conversationRepository.appendMessage(
        conversationId: conversationId,
        role: MessageRole.assistant,
        content: contentBuffer.toString(),
        thinking: thinkingBuffer.isEmpty ? null : thinkingBuffer.toString(),
        provider: provider,
        model: servedModel,
        servedBy: servedBy,
      );
      final savedId = saved.when(success: (message) => message.id, error: (_) => null);
      if (savedId != null && savedId.isNotEmpty) {
        yield AiStreamEvent(type: AiStreamEventType.saved, messageId: savedId, servedBy: servedBy, model: servedModel);
      }
    }
  }
}
