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

  /// For [AiStreamEventType.meta] on ARO: which ARO model answered
  /// ('aro-code', ...), and a note to show (e.g. why Auto used ARO 1.5).
  final String? aroModel;
  final String? notice;

  /// For [AiStreamEventType.meta] on ARO: requests left today (null = no cap).
  final int? remaining;

  const AiStreamEvent({
    required this.type,
    this.text = '',
    this.servedBy,
    this.model,
    this.messageId,
    this.aroModel,
    this.notice,
    this.remaining,
  });
}
