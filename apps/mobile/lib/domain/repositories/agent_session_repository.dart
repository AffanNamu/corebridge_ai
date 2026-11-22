import '../entities/agent_session.dart';

abstract class AgentSessionRepository {
  Stream<List<AgentSession>> watchSessions(String ownerId, String repoOwner, String repoName);
  Future<AgentSession?> getSession(String id);

  /// Creates the session when [AgentSession.id] is empty, otherwise
  /// overwrites it. Returns the saved session (with its id).
  Future<AgentSession> save(AgentSession session);
  Future<void> delete(String id);
}
