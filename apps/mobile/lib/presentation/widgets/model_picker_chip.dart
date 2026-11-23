import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../../core/providers/selected_model_provider.dart';
import '../../core/theme/app_theme.dart';

class ModelPickerChip extends ConsumerWidget {
  const ModelPickerChip({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final selected = ref.watch(selectedModelProvider);
    final thinkingEnabled = ref.watch(thinkingModeEnabledProvider);
    final webEnabled = ref.watch(webSearchEnabledProvider);
    final docsOnly = ref.watch(knowledgeOnlyProvider);

    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        PopupMenuButton<AiModelOption>(
          initialValue: selected,
          onSelected: (option) => ref.read(selectedModelProvider.notifier).state = option,
          color: AppColors.surfaceRaised,
          offset: const Offset(0, -8),
          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(AppRadii.md)),
          itemBuilder: (context) => availableModels
              .map((option) => PopupMenuItem(
                    value: option,
                    child: Row(
                      children: [
                        Text(option.label),
                        if (option.supportsThinking) ...[
                          const SizedBox(width: 6),
                          const Icon(Icons.psychology_outlined, size: 14, color: AppColors.accentBlue),
                        ],
                      ],
                    ),
                  ))
              .toList(),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              Text(
                selected.label,
                style: const TextStyle(color: AppColors.textSecondary, fontSize: 13, fontWeight: FontWeight.w500),
              ),
              const SizedBox(width: 2),
              const Icon(Icons.keyboard_arrow_down_rounded, size: 16, color: AppColors.textMuted),
            ],
          ),
        ),
        if (selected.supportsThinking) ...[
          const SizedBox(width: 6),
          InkWell(
            borderRadius: BorderRadius.circular(14),
            onTap: () => ref.read(thinkingModeEnabledProvider.notifier).state = !thinkingEnabled,
            child: Container(
              padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
              decoration: BoxDecoration(
                color: thinkingEnabled ? AppColors.accentBlue.withValues(alpha: 0.15) : Colors.transparent,
                borderRadius: BorderRadius.circular(14),
              ),
              child: Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  Icon(Icons.psychology_outlined, size: 14, color: thinkingEnabled ? AppColors.accentBlue : AppColors.textMuted),
                  const SizedBox(width: 4),
                  Text(
                    'Thinking',
                    style: TextStyle(
                      fontSize: 12,
                      color: thinkingEnabled ? AppColors.accentBlue : AppColors.textMuted,
                      fontWeight: thinkingEnabled ? FontWeight.w600 : FontWeight.w400,
                    ),
                  ),
                ],
              ),
            ),
          ),
        ],
        const SizedBox(width: 6),
        _ToggleChip(
          icon: Icons.travel_explore_outlined,
          label: 'Web',
          enabled: webEnabled,
          tooltip: 'Search the web and answer from what is online',
          onTap: () => ref.read(webSearchEnabledProvider.notifier).state = !webEnabled,
        ),
        const SizedBox(width: 6),
        _ToggleChip(
          icon: Icons.menu_book_outlined,
          label: 'Docs only',
          enabled: docsOnly,
          tooltip: 'Answer only from your Knowledge Base documents, with citations',
          onTap: () => ref.read(knowledgeOnlyProvider.notifier).state = !docsOnly,
        ),
      ],
    );
  }
}

class _ToggleChip extends StatelessWidget {
  final IconData icon;
  final String label;
  final bool enabled;
  final String tooltip;
  final VoidCallback onTap;

  const _ToggleChip({required this.icon, required this.label, required this.enabled, required this.tooltip, required this.onTap});

  @override
  Widget build(BuildContext context) {
    final color = enabled ? AppColors.accentBlue : AppColors.textMuted;
    return Tooltip(
      message: tooltip,
      child: InkWell(
        borderRadius: BorderRadius.circular(14),
        onTap: onTap,
        child: Container(
          padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
          decoration: BoxDecoration(
            color: enabled ? AppColors.accentBlue.withValues(alpha: 0.15) : Colors.transparent,
            borderRadius: BorderRadius.circular(14),
          ),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              Icon(icon, size: 14, color: color),
              const SizedBox(width: 4),
              Text(label, style: TextStyle(fontSize: 12, color: color, fontWeight: enabled ? FontWeight.w600 : FontWeight.w400)),
            ],
          ),
        ),
      ),
    );
  }
}
