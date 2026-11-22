enum AiStreamEventType {
  /// The model's visible reasoning.
  thinking,

  /// Answer text.
  content,

  /// Who actually answered (ARO, the fallback model, or the user's provider).
  meta,

  /// The finished reply was saved to Firestore under [messageId].
  saved,
}

/// A single event from the AI stream.
class AiStreamEvent {
  final AiStreamEventType type;
  final String text;

  /// For [AiStreamEventType.meta]: 'aro', 'fallback', or the provider id.
  final String? servedBy;

  /// For [AiStreamEventType.meta]: the model that produced the answer.
  final String? model;

  /// For [AiStreamEventType.saved]: the Firestore id of the saved reply.
  final String? messageId;

  const AiStreamEvent({
    required this.type,
    this.text = '',
    this.servedBy,
    this.model,
    this.messageId,
  });
}
