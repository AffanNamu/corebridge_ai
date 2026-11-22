import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/di/providers.dart';
import '../../core/theme/app_theme.dart';

/// Admin dashboard: model availability, plans and limits, pricing, user
/// grants, usage and the model comparison. Every change is checked and
/// audited by the aro-admin Edge Function; non-admins get "Admins only".
class AdminScreen extends ConsumerStatefulWidget {
  const AdminScreen({super.key});

  @override
  ConsumerState<AdminScreen> createState() => _AdminScreenState();
}

class _AdminScreenState extends ConsumerState<AdminScreen> {
  Map<String, dynamic>? _config;
  String? _error;

  Future<dynamic> _call(String action, [Map<String, dynamic> params = const {}]) =>
      ref.read(adminClientProvider).call(action, params);

  @override
  void initState() {
    super.initState();
    _reload();
  }

  Future<void> _reload() async {
    try {
      final config = await _call('config') as Map<String, dynamic>;
      if (mounted) {
        setState(() {
          _config = config;
          _error = null;
        });
      }
    } catch (e) {
      if (mounted) setState(() => _error = _clean(e));
    }
  }

  Future<void> _run(String action, Map<String, dynamic> params, {String? done}) async {
    try {
      await _call(action, params);
      await _reload();
      if (mounted && done != null) _snack(done);
    } catch (e) {
      if (mounted) _snack(_clean(e));
    }
  }

  void _snack(String text) => ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(text)));

  static String _clean(Object e) => e.toString().replaceFirst('HttpException: ', '').replaceFirst('Bad state: ', '');

  @override
  Widget build(BuildContext context) {
    return DefaultTabController(
      length: 5,
      child: Scaffold(
        appBar: AppBar(
          title: const Text('Admin'),
          bottom: const TabBar(
            isScrollable: true,
            tabs: [Tab(text: 'Models'), Tab(text: 'Plans'), Tab(text: 'Users'), Tab(text: 'Usage'), Tab(text: 'Evaluations')],
          ),
        ),
        body: _error != null
            ? Center(child: Padding(padding: const EdgeInsets.all(24), child: Text(_error!, textAlign: TextAlign.center)))
            : _config == null
                ? const Center(child: CircularProgressIndicator())
                : TabBarView(
                    children: [
                      _ModelsTab(config: _config!, run: _run),
                      _PlansTab(config: _config!, run: _run),
                      _UsersTab(config: _config!, call: _call),
                      _UsageTab(call: _call),
                      _EvaluationsTab(call: _call),
                    ],
                  ),
      ),
    );
  }
}

typedef _Run = Future<void> Function(String action, Map<String, dynamic> params, {String? done});
typedef _Call = Future<dynamic> Function(String action, [Map<String, dynamic> params]);

Future<String?> _ask(BuildContext context, String title, {String initial = '', String hint = '', bool number = true}) {
  final controller = TextEditingController(text: initial);
  return showDialog<String>(
    context: context,
    builder: (dialogContext) => AlertDialog(
      backgroundColor: AppColors.surfaceRaised,
      title: Text(title),
      content: TextField(
        controller: controller,
        autofocus: true,
        keyboardType: number ? TextInputType.number : TextInputType.text,
        decoration: InputDecoration(hintText: hint),
      ),
      actions: [
        TextButton(onPressed: () => Navigator.pop(dialogContext), child: const Text('Cancel')),
        FilledButton(onPressed: () => Navigator.pop(dialogContext, controller.text.trim()), child: const Text('Save')),
      ],
    ),
  );
}

Widget _section(BuildContext context, String title, List<Widget> children) => Container(
      margin: const EdgeInsets.only(bottom: 12),
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: AppColors.surface,
        borderRadius: BorderRadius.circular(AppRadii.lg),
        border: Border.all(color: AppColors.border),
      ),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Text(title, style: Theme.of(context).textTheme.titleLarge),
        const SizedBox(height: 8),
        ...children,
      ]),
    );

// ------------------------------------------------------------------ models

class _ModelsTab extends StatelessWidget {
  final Map<String, dynamic> config;
  final _Run run;
  const _ModelsTab({required this.config, required this.run});

  @override
  Widget build(BuildContext context) {
    final models = (config['models'] as List).cast<Map>();
    return ListView(
      padding: const EdgeInsets.all(16),
      children: [
        const Padding(
          padding: EdgeInsets.only(bottom: 12),
          child: Text(
            'Live/Preview models can be used; Planned/Disabled are refused by the server for everyone.',
            style: TextStyle(color: AppColors.textMuted),
          ),
        ),
        ...models.map((m) => _section(context, m['name'] as String, [
              Row(children: [
                const Text('Status', style: TextStyle(color: AppColors.textSecondary)),
                const Spacer(),
                DropdownButton<String>(
                  value: m['status'] as String,
                  dropdownColor: AppColors.surfaceRaised,
                  items: const ['live', 'preview', 'planned', 'disabled']
                      .map((s) => DropdownMenuItem(value: s, child: Text(s)))
                      .toList(),
                  onChanged: (value) => run('updateModel', {'id': m['id'], 'patch': {'status': value}}, done: 'Status updated'),
                ),
              ]),
              Row(children: [
                Text('Credits per request: ${m['credit_cost']}', style: const TextStyle(color: AppColors.textSecondary)),
                const Spacer(),
                TextButton(
                  onPressed: () async {
                    final value = await _ask(context, 'Credits per request', initial: '${m['credit_cost']}', hint: '0 = not sold for credits');
                    if (value != null && value.isNotEmpty) {
                      await run('updateModel', {'id': m['id'], 'patch': {'credit_cost': int.tryParse(value) ?? -1}}, done: 'Saved');
                    }
                  },
                  child: const Text('Edit'),
                ),
              ]),
              SwitchListTile(
                contentPadding: EdgeInsets.zero,
                title: const Text('Shown in the chat model picker', style: TextStyle(color: AppColors.textSecondary)),
                value: m['chat_selectable'] == true,
                onChanged: (v) => run('updateModel', {'id': m['id'], 'patch': {'chat_selectable': v}}),
              ),
            ])),
      ],
    );
  }
}

// ------------------------------------------------------------------- plans

class _PlansTab extends StatelessWidget {
  final Map<String, dynamic> config;
  final _Run run;
  const _PlansTab({required this.config, required this.run});

  @override
  Widget build(BuildContext context) {
    final plans = (config['plans'] as List).cast<Map>();
    final models = (config['models'] as List).cast<Map>();
    final planModels = (config['plan_models'] as List).cast<Map>();
    final products = (config['products'] as List).cast<Map>();
    final packs = (config['credit_packs'] as List).cast<Map>();

    return ListView(
      padding: const EdgeInsets.all(16),
      children: [
        ...plans.map((plan) {
          final limits = {
            for (final pm in planModels.where((pm) => pm['plan_id'] == plan['id'])) pm['model_id'] as String: pm['daily_limit'],
          };
          return _section(context, '${plan['name']} (${plan['id']})', [
            Row(children: [
              Text('Price: ${plan['price_minor']} ${plan['currency']} minor units / month',
                  style: const TextStyle(color: AppColors.textSecondary)),
              const Spacer(),
              TextButton(
                onPressed: () async {
                  final value = await _ask(context, 'Price in minor units (kobo/cents)', initial: '${plan['price_minor']}');
                  if (value != null && value.isNotEmpty) {
                    await run('upsertPlan', {'plan': {'id': plan['id'], 'price_minor': int.tryParse(value) ?? -1}}, done: 'Price saved');
                  }
                },
                child: const Text('Edit'),
              ),
            ]),
            SwitchListTile(
              contentPadding: EdgeInsets.zero,
              title: const Text('Active', style: TextStyle(color: AppColors.textSecondary)),
              value: plan['active'] == true,
              onChanged: (v) => run('upsertPlan', {'plan': {'id': plan['id'], 'active': v}}),
            ),
            const Divider(),
            ...models.map((m) {
              final id = m['id'] as String;
              final included = limits.containsKey(id);
              final limit = limits[id];
              return Row(children: [
                Expanded(child: Text(m['name'] as String, style: const TextStyle(color: AppColors.textPrimary))),
                if (included)
                  TextButton(
                    onPressed: () async {
                      final value = await _ask(context, '${m['name']} — requests per day', initial: limit?.toString() ?? '', hint: 'Empty = no daily cap');
                      if (value != null) {
                        await run('setPlanModel', {
                          'planId': plan['id'], 'modelId': id, 'included': true, 'dailyLimit': value.isEmpty ? null : int.tryParse(value) ?? -1,
                        }, done: 'Limit saved');
                      }
                    },
                    child: Text(limit == null ? 'Unlimited' : '$limit/day'),
                  ),
                Switch(
                  value: included,
                  onChanged: (v) => run('setPlanModel', {'planId': plan['id'], 'modelId': id, 'included': v, 'dailyLimit': included ? limit : 10}),
                ),
              ]);
            }),
          ]);
        }),
        _section(context, 'Individual model purchases', [
          ...products.map((p) => ListTile(
                contentPadding: EdgeInsets.zero,
                title: Text(p['name'] as String),
                subtitle: Text('${p['price_minor']} ${p['currency']} · ${p['duration_days']} days · ${p['daily_limit'] ?? 'no cap'}/day'),
                trailing: TextButton(
                  onPressed: () async {
                    final value = await _ask(context, 'Price in minor units', initial: '${p['price_minor']}');
                    if (value != null && value.isNotEmpty) {
                      await run('upsertProduct', {'product': {...p, 'price_minor': int.tryParse(value) ?? -1}}, done: 'Saved');
                    }
                  },
                  child: const Text('Price'),
                ),
              )),
        ]),
        _section(context, 'Credit packs', [
          ...packs.map((c) => ListTile(
                contentPadding: EdgeInsets.zero,
                title: Text(c['name'] as String),
                subtitle: Text('${c['credits']} credits · ${c['price_minor']} ${c['currency']}'),
                trailing: TextButton(
                  onPressed: () async {
                    final value = await _ask(context, 'Price in minor units', initial: '${c['price_minor']}');
                    if (value != null && value.isNotEmpty) {
                      await run('upsertCreditPack', {'pack': {...c, 'price_minor': int.tryParse(value) ?? -1}}, done: 'Saved');
                    }
                  },
                  child: const Text('Price'),
                ),
              )),
        ]),
      ],
    );
  }
}

// ------------------------------------------------------------------- users

class _UsersTab extends StatefulWidget {
  final Map<String, dynamic> config;
  final _Call call;
  const _UsersTab({required this.config, required this.call});

  @override
  State<_UsersTab> createState() => _UsersTabState();
}

class _UsersTabState extends State<_UsersTab> {
  final _uid = TextEditingController();
  Map<String, dynamic>? _user;
  String? _message;

  Future<void> _lookup() async {
    await _do(() async => _user = await widget.call('userOverview', {'userId': _uid.text.trim()}) as Map<String, dynamic>);
  }

  Future<void> _do(Future<void> Function() action, {String? done}) async {
    try {
      await action();
      setState(() => _message = done);
    } catch (e) {
      setState(() => _message = e.toString().replaceFirst('HttpException: ', ''));
    }
  }

  @override
  Widget build(BuildContext context) {
    final plans = (widget.config['plans'] as List).cast<Map>();
    final models = (widget.config['models'] as List).cast<Map>();
    final uid = _uid.text.trim();
    return ListView(
      padding: const EdgeInsets.all(16),
      children: [
        TextField(
          controller: _uid,
          decoration: InputDecoration(
            hintText: "User's Firebase UID (Firebase console → Authentication)",
            suffixIcon: IconButton(icon: const Icon(Icons.search), onPressed: _lookup),
          ),
          onSubmitted: (_) => _lookup(),
        ),
        if (_message != null) Padding(padding: const EdgeInsets.only(top: 8), child: Text(_message!)),
        if (_user != null) ...[
          const SizedBox(height: 12),
          _section(context, 'Plan: ${(_user!['plan'] as Map?)?['name']} · ${_user!['credits']} credits', [
            Wrap(spacing: 8, runSpacing: 8, children: [
              ...plans.map((p) => OutlinedButton(
                    onPressed: () async {
                      final days = await _ask(context, 'Give ${p['name']} for how many days?', initial: '30', hint: 'Empty = no end date');
                      if (days == null) return;
                      await _do(() async {
                        _user = await widget.call('grantPlan', {'userId': uid, 'planId': p['id'], 'days': days.isEmpty ? null : int.tryParse(days)}) as Map<String, dynamic>;
                      }, done: 'Plan set to ${p['name']}');
                    },
                    child: Text('Set ${p['name']}'),
                  )),
              FilledButton.tonal(
                onPressed: () async {
                  final amount = await _ask(context, 'Add credits (negative to remove)', initial: '100');
                  if (amount == null || amount.isEmpty) return;
                  await _do(() async {
                    await widget.call('addCredits', {'userId': uid, 'amount': int.tryParse(amount), 'reason': 'admin'});
                    _user = await widget.call('userOverview', {'userId': uid}) as Map<String, dynamic>;
                  }, done: 'Credits updated');
                },
                child: const Text('Credits'),
              ),
            ]),
          ]),
          _section(context, 'Models', [
            ...((_user!['models'] as List).cast<Map>()).map((m) => ListTile(
                  contentPadding: EdgeInsets.zero,
                  title: Text(m['name'] as String),
                  subtitle: Text(m['included'] == true
                      ? '${m['used_today']} used today · limit ${m['daily_limit'] ?? 'none'}'
                      : 'Not included'),
                  trailing: TextButton(
                    onPressed: () async {
                      final days = await _ask(context, 'Give ${m['name']} for how many days?', initial: '30');
                      if (days == null) return;
                      final model = models.firstWhere((x) => x['id'] == m['id']);
                      await _do(() async {
                        _user = await widget.call('grantModel', {
                          'userId': uid, 'modelId': model['id'], 'days': days.isEmpty ? null : int.tryParse(days),
                        }) as Map<String, dynamic>;
                      }, done: '${m['name']} granted');
                    },
                    child: const Text('Grant'),
                  ),
                )),
          ]),
        ],
      ],
    );
  }
}

// ------------------------------------------------------------------- usage

class _UsageTab extends StatefulWidget {
  final _Call call;
  const _UsageTab({required this.call});

  @override
  State<_UsageTab> createState() => _UsageTabState();
}

class _UsageTabState extends State<_UsageTab> {
  int _days = 7;
  List<Map>? _rows;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    final rows = await widget.call('usage', {'days': _days}) as List;
    if (mounted) setState(() => _rows = rows.cast<Map>());
  }

  @override
  Widget build(BuildContext context) {
    return ListView(
      padding: const EdgeInsets.all(16),
      children: [
        SegmentedButton<int>(
          segments: const [ButtonSegment(value: 1, label: Text('Today')), ButtonSegment(value: 7, label: Text('7 days')), ButtonSegment(value: 30, label: Text('30 days'))],
          selected: {_days},
          onSelectionChanged: (s) {
            setState(() => _days = s.first);
            _load();
          },
        ),
        const SizedBox(height: 12),
        if (_rows == null)
          const Center(child: CircularProgressIndicator())
        else if (_rows!.isEmpty)
          const Text('No usage yet.')
        else
          DataTable(
            columns: const [DataColumn(label: Text('Model')), DataColumn(label: Text('Requests')), DataColumn(label: Text('Users')), DataColumn(label: Text('Credits'))],
            rows: _rows!
                .map((r) => DataRow(cells: [
                      DataCell(Text('${r['model_id']}')),
                      DataCell(Text('${r['requests']}')),
                      DataCell(Text('${r['users']}')),
                      DataCell(Text('${r['credits_spent']}')),
                    ]))
                .toList(),
          ),
      ],
    );
  }
}

// ------------------------------------------------------------- evaluations

class _EvaluationsTab extends StatefulWidget {
  final _Call call;
  const _EvaluationsTab({required this.call});

  @override
  State<_EvaluationsTab> createState() => _EvaluationsTabState();
}

class _EvaluationsTabState extends State<_EvaluationsTab> {
  List<Map>? _rows;

  @override
  void initState() {
    super.initState();
    widget.call('evaluations', {'limit': 100}).then((rows) {
      if (mounted) setState(() => _rows = (rows as List).cast<Map>());
    });
  }

  @override
  Widget build(BuildContext context) {
    if (_rows == null) return const Center(child: CircularProgressIndicator());
    if (_rows!.isEmpty) {
      return const Center(
        child: Padding(
          padding: EdgeInsets.all(24),
          child: Text('No evaluations yet. They appear here after each training run (set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY on the GPU machine).', textAlign: TextAlign.center),
        ),
      );
    }
    return SingleChildScrollView(
      padding: const EdgeInsets.all(16),
      scrollDirection: Axis.horizontal,
      child: SingleChildScrollView(
        child: DataTable(
          columns: const [
            DataColumn(label: Text('Model')), DataColumn(label: Text('Run')), DataColumn(label: Text('When')),
            DataColumn(label: Text('New')), DataColumn(label: Text('Current')), DataColumn(label: Text('Δ')),
            DataColumn(label: Text('Latency s')), DataColumn(label: Text('Result')),
          ],
          rows: _rows!.map((r) {
            final cand = (r['candidate_score'] as num).toDouble();
            final curr = (r['current_score'] as num).toDouble();
            final latency = ((r['metrics'] as Map?)?['candidate'] as Map?)?['latency_mean_s'];
            return DataRow(cells: [
              DataCell(Text('${r['model_id']}')),
              DataCell(Text('${r['candidate']}')),
              DataCell(Text('${r['created_at']}'.split('T').first)),
              DataCell(Text(cand.toStringAsFixed(3))),
              DataCell(Text(curr.toStringAsFixed(3))),
              DataCell(Text((cand - curr >= 0 ? '+' : '') + (cand - curr).toStringAsFixed(3),
                  style: TextStyle(color: cand >= curr ? Colors.greenAccent : Colors.redAccent))),
              DataCell(Text(latency == null ? '—' : '$latency')),
              DataCell(Text(r['promoted'] == true ? 'Published' : 'Kept current')),
            ]);
          }).toList(),
        ),
      ),
    );
  }
}
