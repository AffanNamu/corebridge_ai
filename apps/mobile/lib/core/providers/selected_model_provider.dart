import 'package:flutter_riverpod/flutter_riverpod.dart';

class AiModelOption {
  final String provider;
  final String label;
  final bool supportsThinking;
  final bool supportsVision;

  /// For provider 'aro': which ARO capability ('auto' lets the server's router
  /// pick one). Null for the bring-your-own-key providers.
  /// ARO is one model family by ARO Group (current generation: ARO 1.5);
  /// Code, Research and Translate are capabilities of ARO 1.5, not separate models.
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
  // ARO, developed by ARO Group. "ARO 1.5 (Auto)" is first, so new users get
  // the central router: it picks the right ARO 1.5 capability for each request.
  AiModelOption(provider: 'aro', label: 'ARO 1.5 (Auto)', aroModel: 'auto', supportsThinking: true, supportsVision: true),
  AiModelOption(provider: 'aro', label: 'ARO 1.5', aroModel: 'aro-1.5', supportsThinking: true),
  AiModelOption(provider: 'aro', label: 'ARO 1.5 · Code', aroModel: 'aro-code', supportsThinking: true),
  AiModelOption(provider: 'aro', label: 'ARO 1.5 · Research', aroModel: 'aro-research', supportsThinking: true),
  AiModelOption(provider: 'aro', label: 'ARO 1.5 · Translate', aroModel: 'aro-translate'),
  // Planned capability, not part of any released ARO generation yet; the server says so if picked.
  AiModelOption(provider: 'aro', label: 'Vision (coming soon)', aroModel: 'aro-vision', supportsVision: true),
  AiModelOption(provider: 'claude', label: 'Claude', supportsThinking: true, supportsVision: true),
  AiModelOption(provider: 'openai', label: 'ChatGPT', supportsThinking: false, supportsVision: true),
  AiModelOption(provider: 'gemini', label: 'Gemini', supportsThinking: true, supportsVision: true),
  AiModelOption(provider: 'qwen', label: 'Qwen', supportsThinking: true, supportsVision: true),
];

final selectedModelProvider = StateProvider<AiModelOption>((ref) => availableModels.first);

final thinkingModeEnabledProvider = StateProvider<bool>((ref) => false);

/// "Web": answer from a live web search instead of training data only.
/// Off still lets the server search when the message asks for it ("search online…").
final webSearchEnabledProvider = StateProvider<bool>((ref) => false);

/// "Only my documents": answer only from the Knowledge Base, never guess.
final knowledgeOnlyProvider = StateProvider<bool>((ref) => false);

final draftMessageProvider = StateProvider<String>((ref) => '');

/// Guards against re-applying the user's saved default provider every
/// time ChatScreen is opened in the same app session — set once, true
/// after the first apply attempt (whether or not a default existed).
/// Without this, switching providers mid-session and then navigating
/// away and back to Chat would silently snap back to the saved default,
/// which would be confusing rather than helpful.
final defaultProviderAppliedProvider = StateProvider<bool>((ref) => false);
