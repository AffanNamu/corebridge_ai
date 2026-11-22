import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/di/providers.dart';
import '../../core/theme/app_theme.dart';

/// "Models & Plan": the seven ARO models, what the user's plan includes,
/// today's usage, credits and the plan comparison — all from the server
/// (ai-router 'overview'), which is also what enforces access.
class PlanScreen extends ConsumerStatefulWidget {
  const PlanScreen({super.key});

  @override
  ConsumerState<PlanScreen> createState() => _PlanScreenState();
}

class _PlanScreenState extends ConsumerState<PlanScreen> {
  Map<String, dynamic>? _data;
  String? _error;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() => _error = null);
    try {
      final data = await ref.read(aiRouterClientProvider).overview();
      if (mounted) setState(() => _data = data);
    } catch (e) {
      if (mounted) setState(() => _error = e.toString().replaceFirst('HttpException: ', ''));
    }
  }

  @override
  Widget build(BuildContext context) {
    final data = _data;
    return Scaffold(
      appBar: AppBar(
        title: const Text('Models & Plan'),
        actions: [
          if (data?['is_admin'] == true)
            TextButton.icon(
              onPressed: () => context.push('/admin'),
              icon: const Icon(Icons.admin_panel_settings_outlined, size: 18),
              label: const Text('Admin'),
            ),
        ],
      ),
      body: _error != null
          ? _ErrorView(message: _error!, onRetry: _load)
          : data == null
              ? const Center(child: CircularProgressIndicator(color: AppColors.accentBlue))
              : RefreshIndicator(onRefresh: _load, child: _buildBody(data)),
    );
  }

  Widget _buildBody(Map<String, dynamic> data) {
    final plan = (data['plan'] as Map?) ?? const {};
    final models = ((data['models'] as List?) ?? const []).cast<Map>();
    final plans = ((data['plans'] as List?) ?? const []).cast<Map>();
    final packs = ((data['credit_packs'] as List?) ?? const []).cast<Map>();
    final products = ((data['products'] as List?) ?? const []).cast<Map>();
    final names = {for (final m in models) m['id'] as String: m['name'] as String};

    return ListView(
      padding: const EdgeInsets.all(20),
      children: [
        _card(
          child: Row(
            children: [
              Container(
                width: 44,
                height: 44,
                decoration: BoxDecoration(gradient: AppColors.brandGradient, borderRadius: BorderRadius.circular(AppRadii.md)),
                alignment: Alignment.center,
                child: const Icon(Icons.workspace_premium_outlined, color: Colors.white),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text('${plan['name'] ?? 'Free'} plan', style: Theme.of(context).textTheme.titleLarge),
                    if (plan['expires_at'] != null)
                      Text('Renews / ends ${_date(plan['expires_at'] as String)}', style: Theme.of(context).textTheme.labelSmall),
                  ],
                ),
              ),
              Column(
                crossAxisAlignment: CrossAxisAlignment.end,
                children: [
                  Text('${data['credits'] ?? 0}', style: Theme.of(context).textTheme.titleLarge),
                  Text('credits', style: Theme.of(context).textTheme.labelSmall),
                ],
              ),
            ],
          ),
        ),
        const SizedBox(height: 20),
        Text('ARO models', style: Theme.of(context).textTheme.titleLarge),
        const SizedBox(height: 4),
        Text('Usage resets every day at midnight UTC.', style: Theme.of(context).textTheme.labelSmall),
        const SizedBox(height: 10),
        ...models.map(_modelTile),
        const SizedBox(height: 20),
        Text('Compare plans', style: Theme.of(context).textTheme.titleLarge),
        const SizedBox(height: 10),
        _planTable(plans, names, plan['id'] as String?),
        if (products.isNotEmpty || packs.isNotEmpty) ...[
          const SizedBox(height: 20),
          Text('Buy separately', style: Theme.of(context).textTheme.titleLarge),
          const SizedBox(height: 10),
          ...products.map((p) => _priceRow(p['name'] as String, '${p['duration_days']} days', p)),
          ...packs.map((p) => _priceRow(p['name'] as String, 'credits for any model', p)),
        ],
        const SizedBox(height: 16),
        _card(
          child: const Text(
            'In-app payments are coming soon. To upgrade now, contact the ARO AI team — your plan is applied to your account right away.',
            style: TextStyle(color: AppColors.textSecondary),
          ),
        ),
      ],
    );
  }

  Widget _modelTile(Map model) {
    final status = model['status'] as String? ?? 'planned';
    final included = model['included'] == true;
    final limit = model['daily_limit'];
    final used = model['used_today'] ?? 0;
    final available = status == 'live' || status == 'preview';
    final usage = !available
        ? 'Coming soon'
        : included
            ? (limit == null ? 'Unlimited today · $used used' : '$used of $limit used today')
            : (model['credit_cost'] as num? ?? 0) > 0
                ? 'Not in your plan · ${model['credit_cost']} credits per request'
                : 'Not in your plan';
    final progress = included && limit is num && limit > 0 ? (used as num) / limit : null;

    return Padding(
      padding: const EdgeInsets.only(bottom: 10),
      child: _card(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Expanded(
                  child: Text(model['name'] as String, style: const TextStyle(color: AppColors.textPrimary, fontWeight: FontWeight.w600)),
                ),
                _StatusChip(status: status),
              ],
            ),
            const SizedBox(height: 2),
            Text(model['tagline'] as String? ?? '', style: Theme.of(context).textTheme.labelSmall),
            const SizedBox(height: 8),
            Text(usage, style: TextStyle(color: included && available ? AppColors.textSecondary : AppColors.textMuted, fontSize: 13)),
            if (progress != null) ...[
              const SizedBox(height: 6),
              ClipRRect(
                borderRadius: BorderRadius.circular(4),
                child: LinearProgressIndicator(
                  value: progress.clamp(0, 1).toDouble(),
                  minHeight: 5,
                  backgroundColor: AppColors.border,
                  color: progress >= 1 ? Colors.orangeAccent : AppColors.accentBlue,
                ),
              ),
            ],
          ],
        ),
      ),
    );
  }

  Widget _planTable(List<Map> plans, Map<String, String> names, String? current) {
    final modelIds = names.keys.toList();
    return _card(
      child: SingleChildScrollView(
        scrollDirection: Axis.horizontal,
        child: DataTable(
          columnSpacing: 18,
          headingTextStyle: const TextStyle(color: AppColors.textPrimary, fontWeight: FontWeight.w600),
          dataTextStyle: const TextStyle(color: AppColors.textSecondary, fontSize: 13),
          columns: [
            const DataColumn(label: Text('Per day')),
            ...plans.map((p) => DataColumn(
                  label: Text(p['id'] == current ? '${p['name']} ✓' : p['name'] as String),
                )),
          ],
          rows: [
            DataRow(cells: [
              const DataCell(Text('Price / month')),
              ...plans.map((p) => DataCell(Text(_money(p)))),
            ]),
            ...modelIds.map((id) => DataRow(cells: [
                  DataCell(Text(names[id]!)),
                  ...plans.map((p) {
                    final limits = (p['models'] as Map?) ?? const {};
                    if (!limits.containsKey(id)) return const DataCell(Text('—'));
                    final limit = limits[id];
                    return DataCell(Text(limit == null ? 'Unlimited' : '$limit'));
                  }),
                ])),
          ],
        ),
      ),
    );
  }

  Widget _priceRow(String title, String subtitle, Map item) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 8),
      child: _card(
        child: Row(
          children: [
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(title, style: const TextStyle(color: AppColors.textPrimary, fontWeight: FontWeight.w600)),
                  Text(subtitle, style: Theme.of(context).textTheme.labelSmall),
                ],
              ),
            ),
            Text(_money(item), style: const TextStyle(color: AppColors.textPrimary)),
          ],
        ),
      ),
    );
  }

  static String _money(Map item) {
    final minor = (item['price_minor'] as num?) ?? 0;
    if (minor == 0) return 'Free';
    final major = minor / 100;
    final text = major == major.roundToDouble() ? major.toStringAsFixed(0) : major.toStringAsFixed(2);
    final currency = item['currency'] as String? ?? 'NGN';
    return currency == 'NGN' ? '₦$text' : '$currency $text';
  }

  static String _date(String iso) {
    final d = DateTime.tryParse(iso)?.toLocal();
    return d == null ? iso : '${d.day}/${d.month}/${d.year}';
  }

  Widget _card({required Widget child}) => Container(
        padding: const EdgeInsets.all(14),
        decoration: BoxDecoration(
          color: AppColors.surface,
          borderRadius: BorderRadius.circular(AppRadii.lg),
          border: Border.all(color: AppColors.border),
        ),
        child: child,
      );
}

class _StatusChip extends StatelessWidget {
  final String status;
  const _StatusChip({required this.status});

  @override
  Widget build(BuildContext context) {
    final (label, color) = switch (status) {
      'live' => ('Live', Colors.greenAccent),
      'preview' => ('Preview', AppColors.accentBlue),
      'disabled' => ('Off', Colors.redAccent),
      _ => ('Coming soon', AppColors.textMuted),
    };
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
      decoration: BoxDecoration(color: color.withValues(alpha: 0.12), borderRadius: BorderRadius.circular(8)),
      child: Text(label, style: TextStyle(color: color, fontSize: 11, fontWeight: FontWeight.w600)),
    );
  }
}

class _ErrorView extends StatelessWidget {
  final String message;
  final VoidCallback onRetry;
  const _ErrorView({required this.message, required this.onRetry});

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(32),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Text(message, textAlign: TextAlign.center, style: Theme.of(context).textTheme.bodyMedium),
            const SizedBox(height: 12),
            OutlinedButton(onPressed: onRetry, child: const Text('Try again')),
          ],
        ),
      ),
    );
  }
}
