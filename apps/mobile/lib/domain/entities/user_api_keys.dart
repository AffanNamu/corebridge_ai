import '../../core/constants/ai_models.dart';

/// Per-user, per-provider API keys, model strings, a default provider
/// choice, and the user's GitHub connection for the ARO coding agent.
///
/// ARO 1.5 ('aro') is ARO AI's own model and needs no key.
class UserApiKeys {
  final String? claude;
  final String? openai;
  final String? gemini;
  final String? qwen;

  final String? claudeModel;
  final String? openaiModel;
  final String? geminiModel;
  final String? qwenModel;

  /// Qwen's vision models are separate ids from its chat models, so the
  /// one detected for the user's key is stored on its own.
  final String? qwenVisionModel;

  /// Provider key ('aro'/'claude'/'openai'/'gemini'/'qwen') the user picked
  /// as their default. Null/empty means no preference — ARO 1.5 is used.
  final String? defaultProvider;

  /// Fine-grained GitHub personal access token for the coding agent.
  final String? github;

  /// GitHub username the token belongs to (shown in the app).
  final String? githubLogin;

  const UserApiKeys({
    this.claude,
    this.openai,
    this.gemini,
    this.qwen,
    this.claudeModel,
    this.openaiModel,
    this.geminiModel,
    this.qwenModel,
    this.qwenVisionModel,
    this.defaultProvider,
    this.github,
    this.githubLogin,
  });

  factory UserApiKeys.fromMap(Map<String, dynamic>? map) {
    if (map == null) return const UserApiKeys();
    return UserApiKeys(
      claude: map['claude'] as String?,
      openai: map['openai'] as String?,
      gemini: map['gemini'] as String?,
      qwen: map['qwen'] as String?,
      claudeModel: map['claudeModel'] as String?,
      openaiModel: map['openaiModel'] as String?,
      geminiModel: map['geminiModel'] as String?,
      qwenModel: map['qwenModel'] as String?,
      qwenVisionModel: map['qwenVisionModel'] as String?,
      defaultProvider: map['defaultProvider'] as String?,
      github: map['github'] as String?,
      githubLogin: map['githubLogin'] as String?,
    );
  }

  Map<String, dynamic> toMap() {
    return {
      if (claude != null) 'claude': claude,
      if (openai != null) 'openai': openai,
      if (gemini != null) 'gemini': gemini,
      if (qwen != null) 'qwen': qwen,
      if (claudeModel != null) 'claudeModel': claudeModel,
      if (openaiModel != null) 'openaiModel': openaiModel,
      if (geminiModel != null) 'geminiModel': geminiModel,
      if (qwenModel != null) 'qwenModel': qwenModel,
      if (qwenVisionModel != null) 'qwenVisionModel': qwenVisionModel,
      if (defaultProvider != null) 'defaultProvider': defaultProvider,
      if (github != null) 'github': github,
      if (githubLogin != null) 'githubLogin': githubLogin,
    };
  }

  /// Providers that run on the user's own API key. ARO does not.
  static bool requiresKey(String provider) => provider != 'aro';

  bool get hasGitHub => (github ?? '').trim().isNotEmpty;

  String? forProvider(String provider) {
    switch (provider) {
      case 'claude':
        return claude;
      case 'openai':
        return openai;
      case 'gemini':
        return gemini;
      case 'qwen':
        return qwen;
      default:
        return null;
    }
  }

  /// The model to call. When the message has images and the provider uses
  /// separate vision models (Qwen), the detected vision model is preferred.
  String modelFor(String provider, {bool hasImages = false}) {
    if (hasImages && provider == 'qwen') {
      final vision = qwenVisionModel?.trim();
      if (vision != null && vision.isNotEmpty) return vision;
      return AiModels.visionModelFor(provider, AiModels.qwenDefault);
    }
    final override = _modelOverrideFor(provider)?.trim();
    if (override != null && override.isNotEmpty) return override;
    return AiModels.defaultFor(provider);
  }

  String? _modelOverrideFor(String provider) {
    switch (provider) {
      case 'claude':
        return claudeModel;
      case 'openai':
        return openaiModel;
      case 'gemini':
        return geminiModel;
      case 'qwen':
        return qwenModel;
      default:
        return null;
    }
  }

  UserApiKeys copyWith({
    String? claude,
    String? openai,
    String? gemini,
    String? qwen,
    String? claudeModel,
    String? openaiModel,
    String? geminiModel,
    String? qwenModel,
    String? qwenVisionModel,
    String? defaultProvider,
    String? github,
    String? githubLogin,
  }) {
    return UserApiKeys(
      claude: claude ?? this.claude,
      openai: openai ?? this.openai,
      gemini: gemini ?? this.gemini,
      qwen: qwen ?? this.qwen,
      claudeModel: claudeModel ?? this.claudeModel,
      openaiModel: openaiModel ?? this.openaiModel,
      geminiModel: geminiModel ?? this.geminiModel,
      qwenModel: qwenModel ?? this.qwenModel,
      qwenVisionModel: qwenVisionModel ?? this.qwenVisionModel,
      defaultProvider: defaultProvider ?? this.defaultProvider,
      github: github ?? this.github,
      githubLogin: githubLogin ?? this.githubLogin,
    );
  }
}
