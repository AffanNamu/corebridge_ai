import 'package:cloud_firestore/cloud_firestore.dart';

import '../../core/constants/app_constants.dart';
import '../../domain/entities/agent_session.dart';
import '../../domain/repositories/agent_session_repository.dart';

class AgentSessionRepositoryImpl implements AgentSessionRepository {
  final FirebaseFirestore _firestore;

  AgentSessionRepositoryImpl(this._firestore);

  CollectionReference<Map<String, dynamic>> get _sessions =>
      _firestore.collection(AppConstants.agentSessionsCollection);

  @override
  Stream<List<AgentSession>> watchSessions(String ownerId, String repoOwner, String repoName) {
    return _sessions
        .where('ownerId', isEqualTo: ownerId)
        .where('repoFullName', isEqualTo: '$repoOwner/$repoName')
        .orderBy('updatedAt', descending: true)
        .limit(50)
        .snapshots()
        .map((snap) => snap.docs.map((d) => AgentSession.fromMap(d.id, d.data())).toList());
  }

  @override
  Future<AgentSession?> getSession(String id) async {
    final doc = await _sessions.doc(id).get();
    if (!doc.exists || doc.data() == null) return null;
    return AgentSession.fromMap(doc.id, doc.data()!);
  }

  @override
  Future<AgentSession> save(AgentSession session) async {
    if (session.id.isEmpty) {
      final ref = await _sessions.add(session.toMap());
      return session.copyWith(id: ref.id);
    }
    await _sessions.doc(session.id).set(session.toMap());
    return session;
  }

  @override
  Future<void> delete(String id) => _sessions.doc(id).delete();
}
