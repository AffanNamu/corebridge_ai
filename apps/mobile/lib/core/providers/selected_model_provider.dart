import 'package:flutter_riverpod/flutter_riverpod.dart';

class AiModelOption {
  final String provider;
  final String label;
  final bool supportsThinking;
  final bool supportsVision;

  /// For provider 'aro': which ARO model ('auto' lets the server's router
  /// pick the specialist). Null for the bring-your-own-key providers.
  final String? aroModel;

  const AiModelOption({
    required this.provider,
    required this.label,
    this.supportsThinking = false,
    this.supportsVision = false,
    this.aroModel,
  });

  bool get isAro => provider == 'aro';
}

final availableModels = const <AiModelOption>[
  // ARO AI's own models. "ARO (Auto)" is first, so new users get the central
  // router: it sends each request to the right ARO specialist.
  AiModelOption(provider: 'aro', label: 'ARO (Auto)', aroModel: 'auto', supportsThinking: true, supportsVision: true),
  AiModelOption(provider: 'aro', label: 'ARO 1.5', aroModel: 'aro-1.5', supportsThinking: true),
  AiModelOption(provider: 'aro', label: 'ARO Code', aroModel: 'aro-code', supportsThinking: true),
  AiModelOption(provider: 'aro', label: 'ARO Research', aroModel: 'aro-research', supportsThinking: true),
  AiModelOption(provider: 'aro', label: 'ARO Translate', aroModel: 'aro-translate'),
  AiModelOption(provider: 'aro', label: 'ARO Vision', aroModel: 'aro-vision', supportsVision: true),
  AiModelOption(provider: 'claude', label: 'Claude', supportsThinking: true, supportsVision: true),
  AiModelOption(provider: 'openai', label: 'ChatGPT', supportsThinking: false, supportsVision: true),
  AiModelOption(provider: 'gemini', label: 'Gemini', supportsThinking: true, supportsVision: true),
  AiModelOption(provider: 'qwen', label: 'Qwen', supportsThinking: true, supportsVision: true),
];

final selectedModelProvider = StateProvider<AiModelOption>((ref) => availableModels.first);

final thinkingModeEnabledProvider = StateProvider<bool>((ref) => false);

final draftMessageProvider = StateProvider<String>((ref) => '');

/// Guards against re-applying the user's saved default provider every
/// time ChatScreen is opened in the same app session — set once, true
/// after the first apply attempt (whether or not a default existed).
/// Without this, switching providers mid-session and then navigating
/// away and back to Chat would silently snap back to the saved default,
/// which would be confusing rather than helpful.
final defaultProviderAppliedProvider = StateProvider<bool>((ref) => false);
