import '../entities/user_api_keys.dart';

abstract class UserSettingsRepository {
  Future<UserApiKeys> getApiKeys(String uid);
  Future<void> saveApiKeys(String uid, UserApiKeys apiKeys);

  /// Whether the user allows their ARO 1.5 chats to be used to train ARO.
  Future<bool> getTrainingConsent(String uid);
  Future<void> setTrainingConsent(String uid, bool allowed);
}
