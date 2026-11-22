import 'package:equatable/equatable.dart';
import 'chat_attachment.dart';

enum MessageRole { user, assistant, system }

class MessageEntity extends Equatable {
  final String id;
  final String conversationId;
  final MessageRole role;
  final String content;
  final String thinking;
  final bool isStreaming;
  final bool isThinkingStreaming;
  final bool wasStopped;
  final List<ChatAttachment> attachments;
  final DateTime createdAt;

  /// Provider the user picked ('aro', 'claude', ...), for assistant replies.
  final String? provider;

  /// Model that produced the reply.
  final String? model;

  /// Who actually answered: 'aro' (our own model), 'fallback' (the backup
  /// used while the ARO server is offline), or the user's provider. Only
  /// 'aro' answers are ever used to train ARO.
  final String? servedBy;

  /// User feedback: 1 = 👍, -1 = 👎, 0 = none.
  final int rating;

  /// The user's better answer, given with a 👎.
  final String? correction;

  const MessageEntity({
    required this.id,
    required this.conversationId,
    required this.role,
    required this.content,
    this.thinking = '',
    this.isStreaming = false,
    this.isThinkingStreaming = false,
    this.wasStopped = false,
    this.attachments = const [],
    required this.createdAt,
    this.provider,
    this.model,
    this.servedBy,
    this.rating = 0,
    this.correction,
  });

  factory MessageEntity.fromMap(String id, String conversationId, Map<String, dynamic> map) {
    return MessageEntity(
      id: id,
      conversationId: conversationId,
      role: MessageRole.values.firstWhere(
        (r) => r.name == map['role'],
        orElse: () => MessageRole.user,
      ),
      content: (map['content'] as String?) ?? '',
      thinking: (map['thinking'] as String?) ?? '',
      isStreaming: (map['isStreaming'] as bool?) ?? false,
      createdAt: DateTime.fromMillisecondsSinceEpoch(map['createdAt'] as int),
      provider: map['provider'] as String?,
      model: map['model'] as String?,
      servedBy: map['servedBy'] as String?,
      rating: (map['rating'] as num?)?.toInt() ?? 0,
      correction: map['correction'] as String?,
    );
  }

  Map<String, dynamic> toMap() {
    return {
      'role': role.name,
      'content': content,
      'thinking': thinking,
      'isStreaming': isStreaming,
      'createdAt': createdAt.millisecondsSinceEpoch,
      if (provider != null) 'provider': provider,
      if (model != null) 'model': model,
      if (servedBy != null) 'servedBy': servedBy,
      if (rating != 0) 'rating': rating,
      if (correction != null) 'correction': correction,
    };
  }

  MessageEntity copyWith({
    String? id,
    String? content,
    String? thinking,
    bool? isStreaming,
    bool? isThinkingStreaming,
    bool? wasStopped,
    List<ChatAttachment>? attachments,
    String? provider,
    String? model,
    String? servedBy,
    int? rating,
    String? correction,
  }) {
    return MessageEntity(
      id: id ?? this.id,
      conversationId: conversationId,
      role: role,
      content: content ?? this.content,
      thinking: thinking ?? this.thinking,
      isStreaming: isStreaming ?? this.isStreaming,
      isThinkingStreaming: isThinkingStreaming ?? this.isThinkingStreaming,
      wasStopped: wasStopped ?? this.wasStopped,
      attachments: attachments ?? this.attachments,
      createdAt: createdAt,
      provider: provider ?? this.provider,
      model: model ?? this.model,
      servedBy: servedBy ?? this.servedBy,
      rating: rating ?? this.rating,
      correction: correction ?? this.correction,
    );
  }

  @override
  List<Object?> get props =>
      [id, conversationId, role, content, thinking, isStreaming, isThinkingStreaming, wasStopped, attachments, createdAt, provider, model, servedBy, rating, correction];
}
