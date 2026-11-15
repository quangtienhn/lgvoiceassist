// ESPHome native API message subset (ids and field numbers from aioesphomeapi api.proto, 46.x).
'use strict';

var S = {};
S.VoiceAssistantAudioSettings = { noise_suppression_level: [1, 'uint32'], auto_gain: [2, 'uint32'], volume_multiplier: [3, 'float'] };
S.VoiceAssistantEventData = { name: [1, 'string'], value: [2, 'string'] };
S.VoiceAssistantWakeWord = { id: [1, 'string'], wake_word: [2, 'string'], trained_languages: [3, 'string', null, true] };
S.MediaPlayerSupportedFormat = { format: [1, 'string'], sample_rate: [2, 'uint32'], num_channels: [3, 'uint32'],
  purpose: [4, 'enum'], sample_bytes: [5, 'uint32'] };

var M = {
  HelloRequest: [1, { client_info: [1, 'string'], api_version_major: [2, 'uint32'], api_version_minor: [3, 'uint32'] }],
  HelloResponse: [2, { api_version_major: [1, 'uint32'], api_version_minor: [2, 'uint32'], server_info: [3, 'string'], name: [4, 'string'] }],
  AuthenticationRequest: [3, { password: [1, 'string'] }],
  AuthenticationResponse: [4, { invalid_password: [1, 'bool'] }],
  DisconnectRequest: [5, { reason: [1, 'enum'] }],
  DisconnectResponse: [6, {}],
  PingRequest: [7, {}],
  PingResponse: [8, {}],
  DeviceInfoRequest: [9, {}],
  DeviceInfoResponse: [10, {
    uses_password: [1, 'bool'], name: [2, 'string'], mac_address: [3, 'string'], esphome_version: [4, 'string'],
    compilation_time: [5, 'string'], model: [6, 'string'], project_name: [8, 'string'], project_version: [9, 'string'],
    manufacturer: [12, 'string'], friendly_name: [13, 'string'], suggested_area: [16, 'string'],
    voice_assistant_feature_flags: [17, 'uint32'], api_encryption_supported: [19, 'bool'] }],
  ListEntitiesRequest: [11, {}],
  ListEntitiesDoneResponse: [19, {}],
  SubscribeStatesRequest: [20, {}],
  SubscribeLogsRequest: [28, { level: [1, 'enum'], dump_config: [2, 'bool'] }],
  SubscribeHomeassistantServicesRequest: [34, {}],
  GetTimeRequest: [36, {}],
  GetTimeResponse: [37, { epoch_seconds: [1, 'fixed32'], timezone: [2, 'string'] }],
  SubscribeHomeAssistantStatesRequest: [38, {}],
  ListEntitiesMediaPlayerResponse: [63, {
    object_id: [1, 'string'], key: [2, 'fixed32'], name: [3, 'string'], icon: [5, 'string'],
    supports_pause: [8, 'bool'], supported_formats: [9, 'message', S.MediaPlayerSupportedFormat, true],
    feature_flags: [11, 'uint32'] }],
  MediaPlayerStateResponse: [64, { key: [1, 'fixed32'], state: [2, 'enum'], volume: [3, 'float'], muted: [4, 'bool'] }],
  MediaPlayerCommandRequest: [65, {
    key: [1, 'fixed32'], has_command: [2, 'bool'], command: [3, 'enum'], has_volume: [4, 'bool'], volume: [5, 'float'],
    has_media_url: [6, 'bool'], media_url: [7, 'string'], has_announcement: [8, 'bool'], announcement: [9, 'bool'] }],
  SubscribeVoiceAssistantRequest: [89, { subscribe: [1, 'bool'], flags: [2, 'uint32'] }],
  VoiceAssistantRequest: [90, {
    start: [1, 'bool'], conversation_id: [2, 'string'], flags: [3, 'uint32'],
    audio_settings: [4, 'message', S.VoiceAssistantAudioSettings], wake_word_phrase: [5, 'string'] }],
  VoiceAssistantResponse: [91, { port: [1, 'uint32'], error: [2, 'bool'] }],
  VoiceAssistantEventResponse: [92, { event_type: [1, 'enum'], data: [2, 'message', S.VoiceAssistantEventData, true] }],
  VoiceAssistantAudio: [106, { data: [1, 'bytes'], end: [2, 'bool'] }],
  VoiceAssistantTimerEventResponse: [115, {
    event_type: [1, 'enum'], timer_id: [2, 'string'], name: [3, 'string'], total_seconds: [4, 'uint32'],
    seconds_left: [5, 'uint32'], is_active: [6, 'bool'] }],
  VoiceAssistantAnnounceRequest: [119, {
    media_id: [1, 'string'], text: [2, 'string'], preannounce_media_id: [3, 'string'], start_conversation: [4, 'bool'] }],
  VoiceAssistantAnnounceFinished: [120, { success: [1, 'bool'] }],
  VoiceAssistantConfigurationRequest: [121, {}],
  VoiceAssistantConfigurationResponse: [122, {
    available_wake_words: [1, 'message', S.VoiceAssistantWakeWord, true],
    active_wake_words: [2, 'string', null, true], max_active_wake_words: [3, 'uint32'] }],
  VoiceAssistantSetConfiguration: [123, { active_wake_words: [1, 'string', null, true] }]
};

var byId = {};
Object.keys(M).forEach(function (name) { byId[M[name][0]] = name; });

var E = {
  VA_EVENT: { 0: 'ERROR', 1: 'RUN_START', 2: 'RUN_END', 3: 'STT_START', 4: 'STT_END', 5: 'INTENT_START', 6: 'INTENT_END',
    7: 'TTS_START', 8: 'TTS_END', 9: 'WAKE_WORD_START', 10: 'WAKE_WORD_END', 11: 'STT_VAD_START', 12: 'STT_VAD_END',
    13: 'WAKE_WORD_REJECTED', 98: 'TTS_STREAM_START', 99: 'TTS_STREAM_END', 100: 'INTENT_PROGRESS' },
  TIMER_EVENT: { 0: 'STARTED', 1: 'UPDATED', 2: 'CANCELLED', 3: 'FINISHED' },
  MP_STATE: { NONE: 0, IDLE: 1, PLAYING: 2, PAUSED: 3, ANNOUNCING: 4 },
  MP_CMD: { 0: 'PLAY', 1: 'PAUSE', 2: 'STOP', 3: 'MUTE', 4: 'UNMUTE', 5: 'TOGGLE', 6: 'VOLUME_UP', 7: 'VOLUME_DOWN' },
  VA_FEATURE: { VOICE_ASSISTANT: 1, SPEAKER: 2, API_AUDIO: 4, TIMERS: 8, ANNOUNCE: 16, START_CONVERSATION: 32 },
  VA_REQUEST_FLAG: { USE_VAD: 1, USE_WAKE_WORD: 2 },
  // Home Assistant MediaPlayerEntityFeature bits
  MP_FEATURE: { PAUSE: 1, VOLUME_SET: 4, VOLUME_MUTE: 8, PLAY_MEDIA: 512, STOP: 4096, PLAY: 16384, MEDIA_ANNOUNCE: 1048576 }
};

module.exports = { M: M, S: S, byId: byId, E: E };
