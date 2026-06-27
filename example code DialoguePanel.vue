<script setup lang="ts">
import {
  AudioLines,
  ArrowDownUp,
  ArrowLeftRight,
  Check,
  ChartNoAxesGantt,
  ChevronDown,
  ChevronUp,
  CopyPlus,
  Database,
  Download,
  Eye,
  EyeClosed,
  GripVertical,
  Info,
  ListPlus,
  Loader,
  LoaderCircle,
  Maximize2,
  Mic2,
  Minus,
  Pause,
  Play,
  Plus,
  Square,
  Trash,
  Trash2,
  Upload,
  Volume2,
  VolumeX,
  WandSparkles,
} from "@lucide/vue";
import { computed, nextTick, onMounted, onUnmounted, reactive, ref, watch } from "vue";
import AudioEditorOverlay from "@/components/AudioEditorOverlay.vue";
import AudioPlaybackControls from "@/components/AudioPlaybackControls.vue";
import ConfirmDialog from "@/components/ConfirmDialog.vue";
import MultiTakesEditor from "@/components/MultiTakesEditor.vue";
import SimpleWaveform from "@/components/SimpleWaveform.vue";
import {
  ApiError,
  audioUrl,
  createDialogue,
  createDialogueConversionJob,
  createDialogueJob,
  createDialogueTakeFromPhrase,
  createVoicePhraseFromDialogueTake,
  createDialogueSourceAudioPlaceholder,
  deleteDialogue,
  deleteDialogueInfoMedia,
  createDialogueRow,
  deleteDialogueRow,
  deleteDialogueTake,
  duplicateDialogueRow,
  downloadDialogueExport,
  getSession,
  getJob,
  overwriteDialogueSourceAudio,
  overwriteDialogueTakeAudio,
  reorderDialogueRows,
  reorderDialogueTakes,
  uploadDialogueSourceAudio,
  setActiveDialogueTake,
  updateDialogue,
  updateDialogueRow,
  updateDialogueTake,
  uploadDialogueInfoMedia,
} from "@/lib/api";
import { clampDialogueInfoHeight, clampDialogueMediaThumbnailSize, readUiPreferences, updateUiPreferences } from "@/lib/uiPreferences";
import type { UndoAction } from "@/lib/undo";
import type {
  DialogueModel,
  Dialogue,
  DialogueRow,
  DialogueTake,
  ExportFormat,
  LanguageCode,
  Session,
  DialogueSearchScopes,
  VoiceProfile,
  VoicePhrase,
  VoiceTake,
} from "@/types/session";

const props = defineProps<{
  session: Session | null;
  dialogue: Dialogue;
  active: boolean;
  instructPresets: string[];
  dialogueSearchQuery: string;
  dialogueSearchScopes: DialogueSearchScopes;
  uiPreferencesResetToken: number;
}>();

const emit = defineEmits<{
  activate: [];
  session: [session: Session];
  error: [message: string];
  toast: [kind: "info" | "success" | "warning" | "error" | "loading", title: string, message?: string];
  undoAction: [action: UndoAction];
}>();

type DeleteTarget =
  | { type: "row"; row: DialogueRow }
  | { type: "take"; take: DialogueTake }
  | { type: "media"; media: Dialogue["info"]["media"][number] }
  | { type: "dialogue" }
  | { type: "clear" }
  | null;
type CapturableAudioElement = HTMLAudioElement & {
  captureStream?: () => MediaStream;
  mozCaptureStream?: () => MediaStream;
};

const languages: LanguageCode[] = ["zh", "en", "de"];
const models: { value: DialogueModel; label: string }[] = [
  { value: "qwen-base", label: "Qwen Base" },
  { value: "cosyvoice3", label: "CosyVoice3" },
];
const defaultCosyVoiceInstruct = "You are a helpful assistant. ";
const playbackSpeedRates = [1, 1.05, 1.1, 1.15, 1.2, 1.25, 1.3, 1.35, 1.4, 0.95, 0.9, 0.85, 0.8, 0.75, 0.7] as const;
const rowDragMimeType = "application/x-voice-gen-dialogue-row";
type PlaybackSpeedRate = (typeof playbackSpeedRates)[number];
const saving = ref(false);
const generatingRowId = ref<string | null>(null);
const convertingRowId = ref<string | null>(null);
const convertingTakeId = ref<string | null>(null);
const generationStatus = ref<Record<string, string>>({});
const generationErrors = ref<Record<string, string>>({});
const dialogueTextDrafts = reactive<Record<string, string>>({});
const cosyInstructDrafts = reactive<Record<string, string>>({});
const selectedPhraseIds = reactive<Record<string, string>>({});
const takeLabelDrafts = reactive<Record<string, string>>({});
const cancellingDialogueTextRows = new Set<string>();
const cancellingCosyInstructRows = new Set<string>();
const lastDialogueTextEditor = ref<HTMLTextAreaElement | null>(null);
const activeDialogueTextRowId = ref<string | null>(null);
const missingTakeIds = ref<Set<string>>(new Set());
const deleteTarget = ref<DeleteTarget>(null);
const draggedRowId = ref<string | null>(null);
const dragOverRowId = ref<string | null>(null);
const rowDragMode = ref<"move" | "copy" | null>(null);
const rowDuplicateHoverRowId = ref<string | null>(null);
const draggedTakeId = ref<string | null>(null);
const dragOverTakeId = ref<string | null>(null);
const exportFormat = ref<ExportFormat>("wav");
const exportSilenceMs = ref(1000);
const exporting = ref(false);
const compilingDialoguePreview = ref(false);
const dialoguePreviewPlaying = ref(false);
const dialoguePreviewCache = ref<{ key: string; url: string; audio: HTMLAudioElement } | null>(null);
const rowsHidden = ref(false);
const editingDialogueName = ref(false);
const dialogueNameDraft = ref("");
const infoVisible = ref(false);
const dialogueInfoDescriptionDraft = ref("");
const dialogueInfoDescriptionEditor = ref<HTMLTextAreaElement | null>(null);
const dialogueInfoDescriptionHeight = ref(112);
const dialogueInfoMediaInput = ref<HTMLInputElement | null>(null);
const dialogueInfoMediaUploading = ref(false);
const dialogueInfoMediaDragActive = ref(false);
const dialogueInfoMediaThumbnailSize = ref(128);
const fullscreenDialogueInfoMediaId = ref<string | null>(null);
const dialogueInfoMediaVideoElements = new Map<string, HTMLVideoElement>();
const dialogueInfoMediaVideoState = reactive<Record<string, { currentTime: number; duration: number; paused: boolean; muted: boolean }>>({});
const activeRowId = ref<string | null>(null);
const collapsedRowIds = ref<Set<string>>(new Set());
const initializedCollapsedSessionId = ref<string | null>(null);
const expandedTakeIds = ref<Set<string>>(new Set());
const activePlayback = ref<{
  rowId: string;
  takeId: string;
  audio: HTMLAudioElement;
} | null>(null);
const activeVoiceTakePreview = ref<{
  takeId: string;
  audio: HTMLAudioElement;
} | null>(null);
const activePhrasePreview = ref<{
  rowId: string;
  phraseId: string;
  audio: HTMLAudioElement;
} | null>(null);
const takeAudioElements = new Map<string, HTMLAudioElement>();
const takePlaybackAnimationFrames = new Map<string, number>();
const takePlaybackState = reactive<Record<string, { currentTime: number; duration: number }>>({});
const playingTakeIds = ref<Set<string>>(new Set());
const takePlaybackRates = reactive<Record<string, PlaybackSpeedRate>>({});
const downloadingTakeIds = ref<Set<string>>(new Set());
const openPlaybackRateMenuTakeId = ref<string | null>(null);
const shiftKeyPressed = ref(false);
const speedReplaceHoverTakeId = ref<string | null>(null);
const phraseInsertHoverTakeId = ref<string | null>(null);
const duplicateAppendHoverRowId = ref<string | null>(null);
const dialoguePreviewHover = ref(false);
const audioEditor = ref<{
  kind: "take" | "source";
  sourceLabel: string;
  audioSrc: string;
  rowLabel: string;
  takeId: string;
  takeLabel: string;
} | null>(null);
const multiTakesEditorRowId = ref<string | null>(null);
const sourceAudioInput = ref<HTMLInputElement | null>(null);
const sourceUploadRowId = ref<string | null>(null);
const dialogueTakeAudioInput = ref<HTMLInputElement | null>(null);
const dialogueTakeAudioUploadTargetId = ref<string | null>(null);
const dialogueTextEditors = new Map<string, HTMLTextAreaElement>();
const cosyInstructEditors = new Map<string, HTMLTextAreaElement>();
const pinyinPanelRowId = ref<string | null>(null);
let dialogueInfoDescriptionResizeObserver: ResizeObserver | null = null;
const pairedTextEditorResizeObservers = new Map<string, ResizeObserver>();
const syncingPairedTextEditorHeights = new Set<string>();
const dialogueTextTokens = ["[breath]", "[quick_breath]", "[laughter]", "[cough]", "[accent]"];
const cnPinyinToneMap = {
  a1: "ā",
  a2: "á",
  a3: "ǎ",
  a4: "à",
  e1: "ē",
  e2: "é",
  e3: "ě",
  e4: "è",
  i1: "ī",
  i2: "í",
  i3: "ǐ",
  i4: "ì",
  o1: "ō",
  o2: "ó",
  o3: "ǒ",
  o4: "ò",
  u1: "ū",
  u2: "ú",
  u3: "ǔ",
  u4: "ù",
  v1: "ǖ",
  v2: "ǘ",
  v3: "ǚ",
  v4: "ǜ",
} as const;
const pinyinToneCharacters = (["a", "e", "i", "o", "u", "v"] as const).flatMap((vowel) =>
  ([1, 2, 3, 4] as const).map((tone) => cnPinyinToneMap[`${vowel}${tone}` as keyof typeof cnPinyinToneMap]),
);
const pinyinToneRows = [pinyinToneCharacters.slice(0, 8), pinyinToneCharacters.slice(8, 16), pinyinToneCharacters.slice(16, 24)];
const supportedDialogueInfoMediaTypes = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "image/bmp",
  "video/mp4",
  "video/webm",
  "video/quicktime",
]);
const dialogueInfoMediaAccept = "image/jpeg,image/png,image/gif,image/webp,image/bmp,video/mp4,video/webm,video/quicktime";
const profileColorHexes: Record<string, string> = {
  "gray-100": "#f3f4f6",
  "gray-500": "#6b7280",
  "red-600": "#dc2626",
  "brown-700": "#8b5a2b",
  "amber-600": "#d97706",
  "yellow-600": "#ca8a04",
  "lime-600": "#65a30d",
  "green-600": "#16a34a",
  "emerald-600": "#059669",
  "teal-600": "#0d9488",
  "cyan-600": "#0891b2",
  "blue-600": "#2563eb",
  "violet-600": "#7c3aed",
  "rose-600": "#e11d48",
};

const profiles = computed(() => props.session?.voiceProfiles ?? []);
const allRows = computed(() => props.dialogue.dialogueRows ?? []);
const searchTerms = computed(() =>
  props.dialogueSearchQuery
    .trim()
    .toLocaleLowerCase()
    .split(/\s+/)
    .filter(Boolean),
);
const searchActive = computed(() => searchTerms.value.length > 0);
const rows = computed(() => {
  if (!searchActive.value) return allRows.value;
  if (dialogueMatchesSearch()) return allRows.value;
  return allRows.value.filter((row) => rowMatchesSearch(row));
});
const dialogueCount = computed(() => props.session?.dialogues?.length ?? 1);
const canDeleteDialogue = computed(() => dialogueCount.value > 1);
const canExport = computed(() => allRows.value.some((row) => Boolean(activeDialogueTake(row))));
const allRowsCollapsed = computed(() => rows.value.length > 0 && rows.value.every((row) => collapsedRowIds.value.has(row.id)));
const deleteConfirmation = computed(() => {
  const target = deleteTarget.value;
  if (!target) return { title: "", message: "" };
  if (target.type === "dialogue") {
    return {
      title: "Delete dialogue?",
      message: `This removes "${props.dialogue.name}" and all of its dialogue rows and generated audio files from the session.`,
    };
  }
  if (target.type === "clear") {
    return {
      title: "Clear dialogue rows?",
      message: `This removes all rows from "${props.dialogue.name}". Each row delete is added to undo history.`,
    };
  }
  if (target.type === "row") {
    return {
      title: "Delete dialogue row?",
      message: "This removes the row from the session. The row and its generated audio can be restored from undo history.",
    };
  }
  if (target.type === "media") {
    return {
      title: "Delete media?",
      message: `"${target.media.filename}" will be removed from this dialogue info panel and can be restored from undo history.`,
    };
  }
  return {
    title: "Delete dialogue take?",
    message: "This removes the generated dialogue take from the session and deletes the audio file from disk.",
  };
});
const rowsHiddenToggleLabel = computed(() => (rowsHidden.value ? "Show dialogue rows" : "Hide dialogue rows"));
const rowsHiddenToggleTitle = computed(() => `${rowsHiddenToggleLabel.value} (H)`);
const infoVisibleToggleLabel = computed(() => (infoVisible.value ? "Hide dialogue info" : "Show dialogue info"));
const infoVisibleToggleTitle = computed(() => `${infoVisibleToggleLabel.value} (I)`);
const dialogueInfoDescription = computed(() => props.dialogue.info?.description ?? "");
const dialogueInfoMedia = computed(() => props.dialogue.info?.media ?? []);
const fullscreenDialogueInfoMedia = computed(() => dialogueInfoMedia.value.find((media) => media.id === fullscreenDialogueInfoMediaId.value) ?? null);
const compactDialogueInfoMediaControls = computed(() => dialogueInfoMediaThumbnailSize.value < 190);
const dialogueInfoDescriptionChanged = computed(() => dialogueInfoDescriptionDraft.value !== dialogueInfoDescription.value);

function savedDialogueInfoDescriptionHeight() {
  const height = readUiPreferences().dialogueInfo.descriptionHeights[props.dialogue.id];
  return Number.isFinite(height) ? clampDialogueInfoHeight(height) : 112;
}

function savedDialogueInfoMediaThumbnailSize() {
  const size = readUiPreferences().dialogueInfo.mediaThumbnailSizes[props.dialogue.id];
  return Number.isFinite(size) ? clampDialogueMediaThumbnailSize(size) : 128;
}

watch(
  () => props.session,
  (session) => {
    if (!session) {
      initializedCollapsedSessionId.value = null;
      collapsedRowIds.value = new Set();
      return;
    }
    const initializedId = `${session.id}:${props.dialogue.id}`;
    if (initializedCollapsedSessionId.value === initializedId) return;

    collapsedRowIds.value = new Set(allRows.value.map((row) => row.id));
    dialogueNameDraft.value = props.dialogue.name;
    dialogueInfoDescriptionDraft.value = props.dialogue.info?.description ?? "";
    const preferences = readUiPreferences();
    rowsHidden.value = preferences.dialogueRows.hidden[props.dialogue.id] ?? false;
    infoVisible.value = preferences.dialogueInfo.visible[props.dialogue.id] ?? false;
    dialogueInfoDescriptionHeight.value = savedDialogueInfoDescriptionHeight();
    dialogueInfoMediaThumbnailSize.value = savedDialogueInfoMediaThumbnailSize();
    initializedCollapsedSessionId.value = initializedId;
  },
  { immediate: true },
);

watch(
  () => props.dialogue.name,
  (name) => {
    if (!editingDialogueName.value) dialogueNameDraft.value = name;
  },
  { immediate: true },
);

watch(
  () => props.dialogue.info?.description,
  (description) => {
    if (!dialogueInfoDescriptionChanged.value) dialogueInfoDescriptionDraft.value = description ?? "";
  },
  { immediate: true },
);

watch(
  () => [props.dialogue.id, infoVisible.value],
  () => {
    void nextTick(() => syncDialogueInfoDescriptionResizeObserver());
  },
);

watch(
  () => props.uiPreferencesResetToken,
  () => {
    dialogueInfoDescriptionResizeObserver?.disconnect();
    dialogueInfoDescriptionResizeObserver = null;
    rowsHidden.value = false;
    infoVisible.value = false;
    dialogueInfoDescriptionHeight.value = 112;
    dialogueInfoMediaThumbnailSize.value = 128;
    const editor = dialogueInfoDescriptionEditor.value;
    if (editor) editor.style.height = "112px";
  },
);

function showError(error: unknown) {
  if (error instanceof ApiError) {
    emit("error", error.message);
    return;
  }
  if (typeof error === "string") {
    emit("error", error);
    return;
  }
  emit("error", error instanceof Error ? error.message : "Something went wrong");
}

function allSessionRows(session: Session | null) {
  if (!session) return [];
  return session.dialogues?.length ? session.dialogues.flatMap((dialogue) => dialogue.dialogueRows) : session.dialogueRows;
}

function startDialogueNameEdit() {
  dialogueNameDraft.value = props.dialogue.name;
  editingDialogueName.value = true;
}

async function saveDialogueName() {
  const nextName = dialogueNameDraft.value.trim() || "Dialogue";
  editingDialogueName.value = false;
  if (nextName === props.dialogue.name) {
    dialogueNameDraft.value = props.dialogue.name;
    return;
  }
  await withSaving(() => updateDialogue(props.dialogue.id, { name: nextName }));
}

function cancelDialogueNameEdit() {
  dialogueNameDraft.value = props.dialogue.name;
  editingDialogueName.value = false;
}

async function saveDialogueInfoDescription() {
  await withSaving(() =>
    updateDialogue(props.dialogue.id, {
      info: {
        description: dialogueInfoDescriptionDraft.value.trim(),
      },
    }),
  );
}

function cancelDialogueInfoDescriptionEdit() {
  dialogueInfoDescriptionDraft.value = dialogueInfoDescription.value;
}

function persistRowsHidden() {
  updateUiPreferences((preferences) => ({
    ...preferences,
    dialogueRows: {
      ...preferences.dialogueRows,
      hidden: {
        ...preferences.dialogueRows.hidden,
        [props.dialogue.id]: rowsHidden.value,
      },
    },
  }));
}

function setInfoVisible(visible: boolean) {
  infoVisible.value = visible;
  updateUiPreferences((preferences) => ({
    ...preferences,
    dialogueInfo: {
      ...preferences.dialogueInfo,
      visible: {
        ...preferences.dialogueInfo.visible,
        [props.dialogue.id]: visible,
      },
    },
  }));
  if (visible) {
    void nextTick(() => restoreDialogueInfoDescriptionHeight());
  }
}

function toggleInfoVisible() {
  setInfoVisible(!infoVisible.value);
}

function saveDialogueInfoDescriptionHeight(value: number) {
  const height = clampDialogueInfoHeight(value);
  dialogueInfoDescriptionHeight.value = height;
  updateUiPreferences((preferences) => ({
    ...preferences,
    dialogueInfo: {
      ...preferences.dialogueInfo,
      descriptionHeights: {
        ...preferences.dialogueInfo.descriptionHeights,
        [props.dialogue.id]: height,
      },
    },
  }));
}

function restoreDialogueInfoDescriptionHeight() {
  const editor = dialogueInfoDescriptionEditor.value;
  if (!editor) return;
  dialogueInfoDescriptionHeight.value = savedDialogueInfoDescriptionHeight();
  editor.style.height = `${dialogueInfoDescriptionHeight.value}px`;
}

function syncDialogueInfoDescriptionResizeObserver() {
  dialogueInfoDescriptionResizeObserver?.disconnect();
  dialogueInfoDescriptionResizeObserver = null;
  const editor = dialogueInfoDescriptionEditor.value;
  if (!editor || typeof ResizeObserver === "undefined") return;
  restoreDialogueInfoDescriptionHeight();
  dialogueInfoDescriptionResizeObserver = new ResizeObserver((entries) => {
    const target = entries[0]?.target;
    const height = target instanceof HTMLElement ? target.offsetHeight : NaN;
    if (Number.isFinite(height)) saveDialogueInfoDescriptionHeight(height);
  });
  dialogueInfoDescriptionResizeObserver.observe(editor);
}

function dialogueInfoMediaUrl(filePath: string) {
  if (!props.session) return "";
  return audioUrl(props.session.id, filePath);
}

function filterSupportedDialogueInfoMedia(files: File[]) {
  const supported = files.filter((file) => supportedDialogueInfoMediaTypes.has(file.type));
  const unsupported = files.length - supported.length;
  if (unsupported) {
    emit("toast", "info", "Unsupported media skipped", `${unsupported} file${unsupported === 1 ? "" : "s"} were not image/video formats the app can preview.`);
  }
  return supported;
}

async function uploadDialogueInfoMediaFiles(files: File[]) {
  const supported = filterSupportedDialogueInfoMedia(files);
  if (!supported.length) return;
  dialogueInfoMediaUploading.value = true;
  try {
    emit("session", await uploadDialogueInfoMedia(props.dialogue.id, supported));
    emit("toast", "success", "Media uploaded", `${supported.length} file${supported.length === 1 ? "" : "s"} added to dialogue info.`);
  } catch (error) {
    showError(error);
  } finally {
    dialogueInfoMediaUploading.value = false;
  }
}

function selectDialogueInfoMedia(event: Event) {
  const input = event.target as HTMLInputElement;
  void uploadDialogueInfoMediaFiles(Array.from(input.files ?? []));
  input.value = "";
}

function dropDialogueInfoMedia(event: DragEvent) {
  dialogueInfoMediaDragActive.value = false;
  void uploadDialogueInfoMediaFiles(Array.from(event.dataTransfer?.files ?? []));
}

function persistDialogueInfoMediaThumbnailSize() {
  updateUiPreferences((preferences) => ({
    ...preferences,
    dialogueInfo: {
      ...preferences.dialogueInfo,
      mediaThumbnailSizes: {
        ...preferences.dialogueInfo.mediaThumbnailSizes,
        [props.dialogue.id]: dialogueInfoMediaThumbnailSize.value,
      },
    },
  }));
}

function resizeDialogueInfoMediaThumbnails(offset: number) {
  dialogueInfoMediaThumbnailSize.value = clampDialogueMediaThumbnailSize(dialogueInfoMediaThumbnailSize.value + offset);
  persistDialogueInfoMediaThumbnailSize();
}

function dialogueInfoMediaVideoStatus(mediaId: string) {
  return dialogueInfoMediaVideoState[mediaId] ?? { currentTime: 0, duration: 0, paused: true, muted: false };
}

function registerDialogueInfoMediaVideo(mediaId: string, element: unknown) {
  if (element instanceof HTMLVideoElement) {
    dialogueInfoMediaVideoElements.set(mediaId, element);
    updateDialogueInfoMediaVideoState(mediaId, element);
    return;
  }
  dialogueInfoMediaVideoElements.delete(mediaId);
}

function updateDialogueInfoMediaVideoState(mediaId: string, eventOrElement: Event | HTMLVideoElement) {
  const video = eventOrElement instanceof HTMLVideoElement ? eventOrElement : (eventOrElement.currentTarget as HTMLVideoElement);
  dialogueInfoMediaVideoState[mediaId] = {
    currentTime: Number.isFinite(video.currentTime) ? video.currentTime : 0,
    duration: Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 0,
    paused: video.paused,
    muted: video.muted,
  };
}

function toggleDialogueInfoMediaVideoPlayback(mediaId: string) {
  const video = dialogueInfoMediaVideoElements.get(mediaId);
  if (!video) return;
  if (video.paused || video.ended) {
    void video.play();
  } else {
    video.pause();
  }
  updateDialogueInfoMediaVideoState(mediaId, video);
}

function seekDialogueInfoMediaVideo(mediaId: string, event: Event) {
  const video = dialogueInfoMediaVideoElements.get(mediaId);
  if (!video) return;
  video.currentTime = Number((event.target as HTMLInputElement).value);
  updateDialogueInfoMediaVideoState(mediaId, video);
}

function toggleDialogueInfoMediaVideoMuted(mediaId: string) {
  const video = dialogueInfoMediaVideoElements.get(mediaId);
  if (!video) return;
  video.muted = !video.muted;
  updateDialogueInfoMediaVideoState(mediaId, video);
}

function formatCompactMediaTime(value: number) {
  if (!Number.isFinite(value) || value <= 0) return "0:00";
  const minutes = Math.floor(value / 60);
  const seconds = Math.floor(value % 60);
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

async function addDialogue() {
  try {
    emit("session", await createDialogue());
    emit("toast", "success", "Dialogue created");
  } catch (error) {
    showError(error);
  }
}

function dialogueTextValue(row: DialogueRow) {
  return dialogueTextDrafts[row.id] ?? row.text;
}

function cosyInstructValue(row: DialogueRow) {
  return cosyInstructDrafts[row.id] ?? row.cosyvoice.instructText ?? row.instructText ?? defaultCosyVoiceInstruct;
}

function cosyInstructCharacterCount(row: DialogueRow) {
  return Array.from(cosyInstructValue(row)).length;
}

async function withSaving(action: () => Promise<Session>) {
  saving.value = true;
  try {
    emit("session", await action());
  } catch (error) {
    showError(error);
  } finally {
    saving.value = false;
  }
}

function activeTakeForProfile(profile: VoiceProfile | undefined) {
  if (!profile) return null;
  return profile.audioTakes.find((take) => take.id === profile.activeTakeId) ?? profile.audioTakes[0] ?? null;
}

function findProfile(profileId?: string | null) {
  return profiles.value.find((profile) => profile.id === profileId);
}

function voiceProfileLabel(row: DialogueRow) {
  return findProfile(row.voiceProfileId)?.name ?? "No voice profile";
}

function voiceProfileTags(row: DialogueRow) {
  return findProfile(row.voiceProfileId)?.tags ?? [];
}

function voiceProfileColor(row: DialogueRow) {
  return profileColorHexes[findProfile(row.voiceProfileId)?.color ?? "gray-500"] ?? profileColorHexes["gray-500"];
}

function takesForRow(row: DialogueRow) {
  return findProfile(row.voiceProfileId)?.audioTakes ?? [];
}

function phrasesForRow(row: DialogueRow) {
  return findProfile(row.voiceProfileId)?.phrases ?? [];
}

function selectedPhrase(row: DialogueRow) {
  const phrases = phrasesForRow(row);
  const selectedId = selectedPhraseIds[row.id];
  return phrases.find((phrase) => phrase.id === selectedId) ?? phrases[0] ?? null;
}

function selectedVoiceTake(row: DialogueRow) {
  return takesForRow(row).find((take) => take.id === row.voiceTakeId) ?? null;
}

function activeDialogueTake(row: DialogueRow) {
  return row.audioTakes.find((take) => take.id === row.activeTakeId) ?? null;
}

function matchesSearchTerms(values: Array<string | null | undefined>) {
  const haystack = values.filter(Boolean).join(" ").toLocaleLowerCase();
  return searchTerms.value.every((term) => haystack.includes(term));
}

function scopedSearchMatches(groups: Partial<Record<keyof DialogueSearchScopes, Array<string | null | undefined>>>) {
  const selectedValues = Object.entries(groups)
    .filter(([scope]) => props.dialogueSearchScopes[scope as keyof DialogueSearchScopes])
    .flatMap(([, values]) => values);
  return matchesSearchTerms(selectedValues);
}

function dialogueMatchesSearch() {
  return scopedSearchMatches({
    meta: [
      props.dialogue.name,
      props.dialogue.info?.description,
      ...(props.dialogue.info?.media ?? []).flatMap((media) => [media.filename, media.contentType, media.kind]),
    ],
  });
}

function rowMatchesSearch(row: DialogueRow) {
  const profile = findProfile(row.voiceProfileId);
  const selectedTake = selectedVoiceTake(row);
  return scopedSearchMatches({
    voice: [profile?.name],
    voiceMeta: [
      profile?.language,
      profile?.instruct,
      profile?.refSeedText,
      profile?.color,
      ...(profile?.tags ?? []),
      ...(profile?.audioTakes ?? []).flatMap((take) => [take.label, take.refText, take.language]),
      ...(profile?.phrases ?? []).flatMap((phrase) => [phrase.label, phrase.refText, phrase.language]),
      selectedTake?.label,
      selectedTake?.refText,
    ],
    text: [
      row.text,
      ...row.audioTakes.flatMap((take) => [take.label, take.params.text, take.params.refText]),
    ],
    instruct: [
      row.instructText,
      row.cosyvoice.instructText,
      ...row.audioTakes.map((take) => take.params.instructText),
    ],
    meta: [
      row.roleLabel,
      row.model,
      row.language,
      row.sourceAudio?.label,
      row.sourceAudio?.originalFilename,
      ...(row.sourceAudio ? [row.sourceAudio.filePath] : []),
      ...row.audioTakes.flatMap((take) => [
        take.language,
        take.filePath,
        take.params.model,
        take.params.voiceProfileLabel,
        take.params.voiceTakeLabel,
        take.params.sourceAudioId,
      ]),
    ],
  });
}

function isZeroShotDialogueTake(take: DialogueTake) {
  return take.params.model === "cosyvoice3" && take.params.cosyUseRefText;
}

function missingReferenceMessage(take: DialogueTake) {
  if (isPhraseDialogueTake(take)) return null;
  const profile = findProfile(take.params.voiceProfileId);
  if (!profile) {
    return `Voice profile "${take.params.voiceProfileLabel ?? take.params.voiceProfileId}" used by ${take.label} no longer exists. Kept the current voice profile and voice take selections.`;
  }
  if (!profile.audioTakes.some((item) => item.id === take.params.voiceTakeId)) {
    return `Voice take "${take.params.voiceTakeLabel ?? take.params.voiceTakeId}" used by ${take.label} no longer exists on "${profile.name}". Kept the current voice profile and voice take selections.`;
  }
  return null;
}

function isPhraseDialogueTake(take: DialogueTake) {
  return Boolean(take.params.sourceAudioId?.startsWith("voice-phrase:"));
}

function voiceTakeAudioUrl(take: VoiceTake) {
  if (!props.session) return undefined;
  const url = audioUrl(props.session.id, take.filePath);
  return take.editedAt ? `${url}?v=${encodeURIComponent(take.editedAt)}` : url;
}

function phraseAudioUrl(phrase: VoicePhrase) {
  if (!props.session) return undefined;
  return audioUrl(props.session.id, phrase.filePath);
}

function dialogueTakeAudioUrl(take: DialogueTake) {
  if (!props.session) return undefined;
  const url = audioUrl(props.session.id, take.filePath);
  return take.editedAt ? `${url}?v=${encodeURIComponent(take.editedAt)}` : url;
}

function safeDownloadNamePart(value: string) {
  return value
    .trim()
    .replace(/[\\/:*?"<>|]+/g, "-")
    .replace(/\s+/g, " ")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function dialogueTakeDownloadName(row: DialogueRow, take: DialogueTake) {
  const extension = take.filePath.match(/\.[a-z0-9]+$/i)?.[0] ?? ".wav";
  const parts = [
    safeDownloadNamePart(row.roleLabel || "dialogue-row"),
    safeDownloadNamePart(take.language || row.language || "dialogue"),
    safeDownloadNamePart(take.label || "take"),
  ].filter(Boolean);
  return `${parts.join(" - ")}${extension}`;
}

function formatPlaybackRate(rate: number) {
  return Number.isInteger(rate) ? rate.toFixed(1) : rate.toString();
}

function dialogueTakeSpeedDownloadName(row: DialogueRow, take: DialogueTake, rate: PlaybackSpeedRate) {
  const baseName = dialogueTakeDownloadName(row, take).replace(/\.[a-z0-9]+$/i, "");
  return `${baseName} - ${formatPlaybackRate(rate)}x.wav`;
}

function playbackRateForTake(take: DialogueTake) {
  return takePlaybackRates[take.id] ?? 1;
}

function setPlaybackRate(take: DialogueTake, rate: PlaybackSpeedRate) {
  takePlaybackRates[take.id] = playbackSpeedRates.includes(rate) ? rate : 1;
  openPlaybackRateMenuTakeId.value = null;
  const audio = takeAudioElements.get(take.id);
  if (audio) {
    audio.playbackRate = playbackRateForTake(take);
    audio.defaultPlaybackRate = playbackRateForTake(take);
    audio.preservesPitch = true;
  }
}

function togglePlaybackRateMenu(take: DialogueTake) {
  openPlaybackRateMenuTakeId.value = openPlaybackRateMenuTakeId.value === take.id ? null : take.id;
}

function isPlaybackRateMenuOpen(take: DialogueTake) {
  return openPlaybackRateMenuTakeId.value === take.id;
}

function isDownloadingTake(take: DialogueTake) {
  return downloadingTakeIds.value.has(take.id);
}

function isSpeedReplaceMode(take: DialogueTake) {
  return shiftKeyPressed.value && speedReplaceHoverTakeId.value === take.id;
}

function isPhraseInsertMode(take: DialogueTake) {
  return shiftKeyPressed.value && phraseInsertHoverTakeId.value === take.id;
}

function isDuplicateAppendMode(row: DialogueRow) {
  return shiftKeyPressed.value && duplicateAppendHoverRowId.value === row.id;
}

function setSpeedReplaceHover(take: DialogueTake, hovered: boolean) {
  if (hovered) {
    speedReplaceHoverTakeId.value = take.id;
    return;
  }
  if (speedReplaceHoverTakeId.value === take.id) {
    speedReplaceHoverTakeId.value = null;
  }
}

function setPhraseInsertHover(take: DialogueTake, hovered: boolean) {
  if (hovered) {
    phraseInsertHoverTakeId.value = take.id;
    return;
  }
  if (phraseInsertHoverTakeId.value === take.id) {
    phraseInsertHoverTakeId.value = null;
  }
}

function setDuplicateAppendHover(row: DialogueRow, hovered: boolean) {
  if (hovered) {
    duplicateAppendHoverRowId.value = row.id;
    return;
  }
  if (duplicateAppendHoverRowId.value === row.id) {
    duplicateAppendHoverRowId.value = null;
  }
}

function setRowDuplicateHover(row: DialogueRow, hovered: boolean) {
  if (hovered) {
    rowDuplicateHoverRowId.value = row.id;
    return;
  }
  if (rowDuplicateHoverRowId.value === row.id) {
    rowDuplicateHoverRowId.value = null;
  }
}

function isRowDuplicateHandleMode(row: DialogueRow) {
  return shiftKeyPressed.value && rowDuplicateHoverRowId.value === row.id;
}

function isDialoguePreviewRegenerateMode() {
  return shiftKeyPressed.value && dialoguePreviewHover.value;
}

function setTakeDownloading(take: DialogueTake, downloading: boolean) {
  const next = new Set(downloadingTakeIds.value);
  if (downloading) {
    next.add(take.id);
  } else {
    next.delete(take.id);
  }
  downloadingTakeIds.value = next;
}

function saveBlob(blob: Blob, filename: string) {
  const anchor = document.createElement("a");
  const objectUrl = URL.createObjectURL(blob);
  anchor.href = objectUrl;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
}

function encodeWav(samples: Float32Array[], sampleRate: number) {
  const channels = samples.length;
  const sampleCount = samples[0]?.length ?? 0;
  const bytesPerSample = 2;
  const blockAlign = channels * bytesPerSample;
  const buffer = new ArrayBuffer(44 + sampleCount * blockAlign);
  const view = new DataView(buffer);
  let offset = 0;
  const writeString = (value: string) => {
    for (let index = 0; index < value.length; index += 1) view.setUint8(offset + index, value.charCodeAt(index));
    offset += value.length;
  };
  writeString("RIFF");
  view.setUint32(offset, 36 + sampleCount * blockAlign, true);
  offset += 4;
  writeString("WAVE");
  writeString("fmt ");
  view.setUint32(offset, 16, true);
  offset += 4;
  view.setUint16(offset, 1, true);
  offset += 2;
  view.setUint16(offset, channels, true);
  offset += 2;
  view.setUint32(offset, sampleRate, true);
  offset += 4;
  view.setUint32(offset, sampleRate * blockAlign, true);
  offset += 4;
  view.setUint16(offset, blockAlign, true);
  offset += 2;
  view.setUint16(offset, bytesPerSample * 8, true);
  offset += 2;
  writeString("data");
  view.setUint32(offset, sampleCount * blockAlign, true);
  offset += 4;
  for (let sampleIndex = 0; sampleIndex < sampleCount; sampleIndex += 1) {
    for (let channel = 0; channel < channels; channel += 1) {
      const sample = Math.max(-1, Math.min(1, samples[channel]?.[sampleIndex] ?? 0));
      view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
      offset += 2;
    }
  }
  return new Blob([buffer], { type: "audio/wav" });
}

function monoSamplesFromChannels(samples: Float32Array[]) {
  const sampleCount = samples[0]?.length ?? 0;
  const mono = new Float32Array(sampleCount);
  if (!sampleCount || !samples.length) return mono;
  for (let sampleIndex = 0; sampleIndex < sampleCount; sampleIndex += 1) {
    let sample = 0;
    for (const channelSamples of samples) {
      sample += channelSamples[sampleIndex] ?? 0;
    }
    mono[sampleIndex] = sample / samples.length;
  }
  return mono;
}

async function renderSpeedAdjustedWavOffline(url: string, rate: PlaybackSpeedRate) {
  const audioContext = new AudioContext();
  const sourceBuffer = await audioContext.decodeAudioData(await (await fetch(url)).arrayBuffer());
  audioContext.close();
  const frameCount = Math.ceil((sourceBuffer.length / rate) * (sourceBuffer.sampleRate / sourceBuffer.sampleRate));
  const offlineContext = new OfflineAudioContext(1, frameCount, sourceBuffer.sampleRate);
  const source = offlineContext.createBufferSource();
  source.buffer = sourceBuffer;
  source.playbackRate.value = rate;
  source.connect(offlineContext.destination);
  source.start();
  const rendered = await offlineContext.startRendering();
  return encodeWav([rendered.getChannelData(0)], rendered.sampleRate);
}

async function captureSpeedAdjustedWav(url: string, rate: PlaybackSpeedRate) {
  const audio = new Audio(url);
  audio.crossOrigin = "anonymous";
  audio.playbackRate = rate;
  audio.defaultPlaybackRate = rate;
  audio.preservesPitch = true;
  audio.volume = 0;
  await new Promise<void>((resolve, reject) => {
    audio.addEventListener("canplaythrough", () => resolve(), { once: true });
    audio.addEventListener("error", () => reject(new Error("Could not load audio for speed-adjusted export")), { once: true });
    audio.load();
  });

  const capturableAudio = audio as CapturableAudioElement;
  const captureStream = capturableAudio.captureStream?.bind(capturableAudio) ?? capturableAudio.mozCaptureStream?.bind(capturableAudio);
  if (!captureStream) return renderSpeedAdjustedWavOffline(url, rate);

  const context = new AudioContext();
  const stream = captureStream() as MediaStream;
  const source = context.createMediaStreamSource(stream);
  const processor = context.createScriptProcessor(4096, 2, 1);
  const silence = context.createGain();
  silence.gain.value = 0;
  const sampleRate = context.sampleRate;
  const chunks: Float32Array[][] = [[]];
  let sampleCount = 0;
  processor.onaudioprocess = (event) => {
    const input = event.inputBuffer;
    const channelSamples = Array.from({ length: input.numberOfChannels }, (_, channel) => input.getChannelData(channel));
    const mono = monoSamplesFromChannels(channelSamples);
    chunks[0].push(mono);
    sampleCount += mono.length;
  };
  source.connect(processor);
  processor.connect(silence);
  silence.connect(context.destination);
  await audio.play();
  await new Promise<void>((resolve) => audio.addEventListener("ended", () => resolve(), { once: true }));
  processor.disconnect();
  silence.disconnect();
  source.disconnect();
  stream.getTracks().forEach((track) => track.stop());
  await context.close();
  const samples = chunks.map((channelChunks) => {
    const channel = new Float32Array(sampleCount);
    let offset = 0;
    for (const chunk of channelChunks) {
      channel.set(chunk, offset);
      offset += chunk.length;
    }
    return channel;
  });
  return encodeWav(samples, sampleRate);
}

async function downloadDialogueTake(row: DialogueRow, take: DialogueTake) {
  const url = dialogueTakeAudioUrl(take);
  if (!url) return;
  const rate = playbackRateForTake(take);
  if (rate === 1) {
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = dialogueTakeDownloadName(row, take);
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    return;
  }
  setTakeDownloading(take, true);
  try {
    saveBlob(await captureSpeedAdjustedWav(url, rate), dialogueTakeSpeedDownloadName(row, take, rate));
  } catch (error) {
    showError(error);
  } finally {
    setTakeDownloading(take, false);
  }
}

async function replaceDialogueTakeWithRenderedSpeed(row: DialogueRow, take: DialogueTake) {
  const url = dialogueTakeAudioUrl(take);
  if (!url) return;
  const rate = playbackRateForTake(take);
  const previousBackupCount = take.backupFilePaths?.length ?? 0;
  setTakeDownloading(take, true);
  saving.value = true;
  try {
    const blob = await captureSpeedAdjustedWav(url, rate);
    const session = await overwriteDialogueTakeAudio(take.id, blob);
    setPlaybackRate(take, 1);
    emit("session", session);
    const nextTake = allSessionRows(session).flatMap((item) => item.audioTakes).find((item) => item.id === take.id);
    const newBackupFilePath = nextTake?.backupFilePaths?.[previousBackupCount];
    if (nextTake && newBackupFilePath) {
      emit("undoAction", {
        id: crypto.randomUUID(),
        type: "dialogue-take-audio-overwrite",
        label: `Render ${nextTake.label} at ${formatPlaybackRate(rate)}x`,
        createdAt: new Date().toISOString(),
        takeId: nextTake.id,
        undoBackupFilePath: newBackupFilePath,
      });
    }
    emit("toast", "success", "Take audio replaced", `${take.label} rendered at ${formatPlaybackRate(rate)}x`);
  } catch (error) {
    showError(error);
  } finally {
    saving.value = false;
    setTakeDownloading(take, false);
  }
}

function clickDialogueTakeDownload(row: DialogueRow, take: DialogueTake) {
  if (isSpeedReplaceMode(take)) {
    void replaceDialogueTakeWithRenderedSpeed(row, take);
    return;
  }
  void downloadDialogueTake(row, take);
}

function openDialogueTakeAudioPicker(take: DialogueTake) {
  dialogueTakeAudioUploadTargetId.value = take.id;
  dialogueTakeAudioInput.value?.click();
}

function clickDialogueTakeUpload(row: DialogueRow, take: DialogueTake, event: MouseEvent) {
  if (event.shiftKey || isPhraseInsertMode(take)) {
    void saveDialogueTakeAsPhrase(row, take);
    return;
  }
  openDialogueTakeAudioPicker(take);
}

async function saveDialogueTakeAsPhrase(row: DialogueRow, take: DialogueTake) {
  const refText = dialogueTextValue(row).trim();
  if (!row.voiceProfileId) {
    emit("toast", "warning", "No voice profile selected", "Choose a voice profile before saving a phrase.");
    return;
  }
  if (!refText) {
    emit("toast", "warning", "Dialogue text is empty", "Enter dialogue text before saving this take as a phrase.");
    return;
  }
  saving.value = true;
  try {
    emit(
      "session",
      await createVoicePhraseFromDialogueTake(row.voiceProfileId, {
        takeId: take.id,
        refText,
      }),
    );
    emit("toast", "info", "Phrase saved", `${take.label} was added to ${voiceProfileLabel(row)}.`);
  } catch (error) {
    showError(error);
  } finally {
    saving.value = false;
  }
}

async function uploadDialogueTakeAudio(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  const takeId = dialogueTakeAudioUploadTargetId.value;
  dialogueTakeAudioUploadTargetId.value = null;
  if (!file || !takeId) return;

  const beforeTake = rows.value.flatMap((row) => row.audioTakes).find((take) => take.id === takeId);
  const previousBackupCount = beforeTake?.backupFilePaths?.length ?? 0;
  saving.value = true;
  try {
    const session = await overwriteDialogueTakeAudio(takeId, file);
    emit("session", session);
    const nextTake = allSessionRows(session).flatMap((row) => row.audioTakes).find((take) => take.id === takeId);
    const newBackupFilePath = nextTake?.backupFilePaths?.[previousBackupCount];
    if (nextTake && newBackupFilePath) {
      emit("undoAction", {
        id: crypto.randomUUID(),
        type: "dialogue-take-audio-overwrite",
        label: `Replace ${nextTake.label}`,
        createdAt: new Date().toISOString(),
        takeId: nextTake.id,
        undoBackupFilePath: newBackupFilePath,
      });
    }
    emit("toast", "success", "Take audio replaced", file.name);
  } catch (error) {
    showError(error);
  } finally {
    saving.value = false;
  }
}

function playbackStateForTake(take: DialogueTake) {
  return takePlaybackState[take.id] ?? { currentTime: 0, duration: take.durationSec ?? 0 };
}

function registerTakeAudio(take: DialogueTake, element: unknown) {
  if (element instanceof HTMLAudioElement) {
    element.playbackRate = playbackRateForTake(take);
    element.defaultPlaybackRate = playbackRateForTake(take);
    element.preservesPitch = true;
    takeAudioElements.set(take.id, element);
    updateTakePlaybackState(take, element);
    return;
  }
  takeAudioElements.delete(take.id);
}

function clearMissingAudio(take: DialogueTake) {
  if (!missingTakeIds.value.has(take.id)) return;
  const next = new Set(missingTakeIds.value);
  next.delete(take.id);
  missingTakeIds.value = next;
}

function updateTakePlaybackState(take: DialogueTake, eventOrElement: Event | HTMLAudioElement) {
  const audio = eventOrElement instanceof HTMLAudioElement ? eventOrElement : (eventOrElement.currentTarget as HTMLAudioElement);
  if (audio.readyState > HTMLMediaElement.HAVE_NOTHING || audio.networkState === HTMLMediaElement.NETWORK_IDLE) {
    clearMissingAudio(take);
  }
  takePlaybackState[take.id] = {
    currentTime: Number.isFinite(audio.currentTime) ? audio.currentTime : 0,
    duration: Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : take.durationSec ?? 0,
  };
}

function stopTakePlaybackAnimation(take: DialogueTake) {
  const animationFrame = takePlaybackAnimationFrames.get(take.id);
  if (animationFrame) {
    window.cancelAnimationFrame(animationFrame);
  }
  takePlaybackAnimationFrames.delete(take.id);
}

function markTakePlaying(take: DialogueTake) {
  const next = new Set(playingTakeIds.value);
  next.add(take.id);
  playingTakeIds.value = next;
}

function markTakeStopped(take: DialogueTake) {
  const next = new Set(playingTakeIds.value);
  next.delete(take.id);
  playingTakeIds.value = next;
}

function startTakePlaybackAnimation(take: DialogueTake, eventOrElement: Event | HTMLAudioElement) {
  const audio = eventOrElement instanceof HTMLAudioElement ? eventOrElement : (eventOrElement.currentTarget as HTMLAudioElement);
  markTakePlaying(take);
  stopTakePlaybackAnimation(take);

  const tick = () => {
    updateTakePlaybackState(take, audio);
    if (!audio.paused && !audio.ended) {
      takePlaybackAnimationFrames.set(take.id, window.requestAnimationFrame(tick));
    } else {
      takePlaybackAnimationFrames.delete(take.id);
      markTakeStopped(take);
    }
  };

  tick();
}

function seekDialogueTake(take: DialogueTake, time: number) {
  const audio = takeAudioElements.get(take.id);
  if (!audio) return;
  audio.currentTime = Math.max(0, Math.min(time, Number.isFinite(audio.duration) ? audio.duration : time));
  updateTakePlaybackState(take, audio);
}

function seekAndActivateDialogueTake(row: DialogueRow, take: DialogueTake, time: number) {
  setActiveTake(row, take);
  seekDialogueTake(take, time);
}

function editableTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false;
  return Boolean(target.closest("input, textarea, select, [contenteditable='true']"));
}

function activeRowAndTake() {
  const row = rows.value.find((item) => item.id === activeRowId.value);
  if (!row) return null;
  const take = activeDialogueTake(row);
  return take ? { row, take } : null;
}

function moveActiveRow(offset: number) {
  if (!rows.value.length) return;
  const currentIndex = Math.max(0, rows.value.findIndex((row) => row.id === activeRowId.value));
  const nextIndex = Math.max(0, Math.min(rows.value.length - 1, currentIndex + offset));
  activeRowId.value = rows.value[nextIndex]?.id ?? null;
}

function moveActiveTakeInRow(row: DialogueRow, offset: number) {
  if (!row.audioTakes.length) return;
  const currentIndex = Math.max(0, row.audioTakes.findIndex((take) => take.id === row.activeTakeId));
  const nextIndex = Math.max(0, Math.min(row.audioTakes.length - 1, currentIndex + offset));
  const nextTake = row.audioTakes[nextIndex];
  if (!nextTake || nextTake.id === row.activeTakeId) return;
  void activateDialogueTake(row, nextTake);
}

async function focusActiveTakeLabel(row: DialogueRow) {
  const take = activeDialogueTake(row);
  if (!take) return;
  if (!isTakeAreaExpanded(row)) {
    toggleTakeArea(row);
    await nextTick();
  }
  const input = document.querySelector<HTMLInputElement>(`[data-dialogue-take-label-id="${take.id}"]`);
  input?.focus();
  input?.select();
}

function setActiveRowCollapsed(collapsed: boolean) {
  const rowId = activeRowId.value;
  if (!rowId) return;
  const next = new Set(collapsedRowIds.value);
  if (collapsed) {
    next.add(rowId);
  } else {
    next.delete(rowId);
  }
  collapsedRowIds.value = next;
}

function setAllRowsCollapsed(collapsed: boolean) {
  collapsedRowIds.value = collapsed ? new Set(rows.value.map((row) => row.id)) : new Set();
}

function toggleRowsHidden() {
  rowsHidden.value = !rowsHidden.value;
  persistRowsHidden();
}

function audioForActiveTake(row: DialogueRow, take: DialogueTake) {
  const mountedAudio = takeAudioElements.get(take.id);
  if (mountedAudio) return mountedAudio;
  if (activePlayback.value?.rowId === row.id && activePlayback.value.takeId === take.id) {
    return activePlayback.value.audio;
  }
  return null;
}

function toggleActiveTakePlayback(row: DialogueRow, take: DialogueTake) {
  const audio = audioForActiveTake(row, take);
  if (!audio) {
    playActiveTake(row);
    return;
  }

  if (audio.paused || audio.ended) {
    if (!activePlayback.value || activePlayback.value.audio !== audio) {
      stopActivePlayback();
    }
    void audio.play();
    startTakePlaybackAnimation(take, audio);
  } else {
    audio.pause();
    stopTakePlaybackAnimation(take);
    markTakeStopped(take);
    if (activePlayback.value?.rowId === row.id && activePlayback.value.takeId === take.id) {
      activePlayback.value = null;
    }
  }
  updateTakePlaybackState(take, audio);
}

function seekActiveTake(row: DialogueRow, take: DialogueTake, time: number) {
  const audio = audioForActiveTake(row, take);
  const state = playbackStateForTake(take);
  const duration = audio && Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : state.duration || take.durationSec || 0;
  const nextTime = Math.max(0, Math.min(time, duration));
  if (!audio) {
    takePlaybackState[take.id] = { currentTime: nextTime, duration };
    return;
  }
  audio.currentTime = nextTime;
  updateTakePlaybackState(take, audio);
}

function handleWindowKeydown(event: KeyboardEvent) {
  if (event.key === "Shift") {
    shiftKeyPressed.value = true;
  }
  if (!props.active) return;
  if (fullscreenDialogueInfoMediaId.value) {
    if (event.key === "Escape") {
      event.preventDefault();
      fullscreenDialogueInfoMediaId.value = null;
    }
    return;
  }
  if (deleteTarget.value) return;

  if (event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey && event.key.toLowerCase() === "g") {
    const row = rows.value.find((item) => item.id === activeRowId.value);
    if (row) {
      event.preventDefault();
      void generateDialogueTake(row);
      return;
    }
  }

  if (editableTarget(event.target)) return;

  if (!event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey && event.key.toLowerCase() === "h") {
    event.preventDefault();
    toggleRowsHidden();
    return;
  }

  if (!event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey && event.key.toLowerCase() === "i") {
    event.preventDefault();
    toggleInfoVisible();
    return;
  }

  if (!activeRowId.value) return;
  const active = activeRowAndTake();

  if (!event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey && event.key === "Enter") {
    const row = rows.value.find((item) => item.id === activeRowId.value);
    if (row) {
      event.preventDefault();
      void focusActiveTakeLabel(row);
    }
    return;
  }

  if (!event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey && event.key.toLowerCase() === "t") {
    const row = rows.value.find((item) => item.id === activeRowId.value);
    if (row) {
      event.preventDefault();
      toggleTakeArea(row);
    }
    return;
  }

  if (event.shiftKey && !event.metaKey && !event.ctrlKey && !event.altKey) {
    if (event.key === "ArrowUp") {
      event.preventDefault();
      const row = rows.value.find((item) => item.id === activeRowId.value);
      if (row) moveActiveTakeInRow(row, -1);
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      const row = rows.value.find((item) => item.id === activeRowId.value);
      if (row) moveActiveTakeInRow(row, 1);
      return;
    }
  }

  if (event.key === "ArrowUp") {
    event.preventDefault();
    moveActiveRow(-1);
    return;
  }
  if (event.key === "ArrowDown") {
    event.preventDefault();
    moveActiveRow(1);
    return;
  }

  if ((event.metaKey || event.ctrlKey) && event.shiftKey) {
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      setAllRowsCollapsed(true);
      return;
    }
    if (event.key === "ArrowRight") {
      event.preventDefault();
      setAllRowsCollapsed(false);
      return;
    }
  }

  if (event.metaKey || event.ctrlKey) {
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      setActiveRowCollapsed(true);
      return;
    }
    if (event.key === "ArrowRight") {
      event.preventDefault();
      setActiveRowCollapsed(false);
      return;
    }
  }

  if (!active) return;
  const { row, take } = active;

  if (event.key === "Delete") {
    event.preventDefault();
    requestDeleteActiveTake(row);
    return;
  }

  const audio = audioForActiveTake(row, take);
  const currentTime = audio?.currentTime ?? playbackStateForTake(take).currentTime;
  const duration = audio && Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : take.durationSec ?? 0;

  if (event.code === "Space") {
    event.preventDefault();
    toggleActiveTakePlayback(row, take);
    return;
  }
  if (event.key === "ArrowLeft") {
    event.preventDefault();
    seekActiveTake(row, take, event.shiftKey ? 0 : currentTime - 1);
    return;
  }
  if (event.key === "ArrowRight") {
    event.preventDefault();
    seekActiveTake(row, take, event.shiftKey ? duration : currentTime + 1);
  }
}

function handleWindowKeyup(event: KeyboardEvent) {
  if (event.key === "Shift") {
    shiftKeyPressed.value = false;
  }
}

function resetModifierHoverState() {
  shiftKeyPressed.value = false;
  speedReplaceHoverTakeId.value = null;
  phraseInsertHoverTakeId.value = null;
  duplicateAppendHoverRowId.value = null;
  rowDuplicateHoverRowId.value = null;
  dialoguePreviewHover.value = false;
}

function sourceAudioUrl(row: DialogueRow) {
  if (!props.session || !row.sourceAudio) return undefined;
  const url = audioUrl(props.session.id, row.sourceAudio.filePath);
  return row.sourceAudio.editedAt ? `${url}?v=${encodeURIComponent(row.sourceAudio.editedAt)}` : url;
}

function playVoiceTakePreview(take: VoiceTake | null) {
  if (!take || !props.session) return;
  const current = activeVoiceTakePreview.value;
  if (current?.takeId === take.id) {
    stopVoiceTakePreview();
    return;
  }

  stopVoiceTakePreview();
  stopActivePlayback();
  const audio = new Audio(voiceTakeAudioUrl(take));
  activeVoiceTakePreview.value = { takeId: take.id, audio };
  audio.addEventListener("ended", stopVoiceTakePreview, { once: true });
  audio.addEventListener(
    "error",
    () => {
      stopVoiceTakePreview();
      emit("error", `Voice take audio is missing: ${take.label}`);
    },
    { once: true },
  );
  void audio.play();
}

function playPhrasePreview(row: DialogueRow) {
  const phrase = selectedPhrase(row);
  if (!phrase || !props.session) return;
  const current = activePhrasePreview.value;
  if (current?.rowId === row.id && current.phraseId === phrase.id) {
    stopPhrasePreview();
    return;
  }

  stopPhrasePreview();
  stopVoiceTakePreview();
  stopActivePlayback();
  const audio = new Audio(phraseAudioUrl(phrase));
  activePhrasePreview.value = { rowId: row.id, phraseId: phrase.id, audio };
  audio.addEventListener("ended", stopPhrasePreview, { once: true });
  audio.addEventListener(
    "error",
    () => {
      stopPhrasePreview();
      emit("error", `Phrase audio is missing: ${phrase.label}`);
    },
    { once: true },
  );
  void audio.play();
}

function stopPhrasePreview() {
  const current = activePhrasePreview.value;
  if (!current) return;
  current.audio.pause();
  current.audio.currentTime = 0;
  activePhrasePreview.value = null;
}

function stopVoiceTakePreview() {
  const current = activeVoiceTakePreview.value;
  if (!current) return;
  current.audio.pause();
  current.audio.currentTime = 0;
  activeVoiceTakePreview.value = null;
}

function isPhrasePreviewPlaying(row: DialogueRow) {
  const phrase = selectedPhrase(row);
  return Boolean(phrase && activePhrasePreview.value?.rowId === row.id && activePhrasePreview.value.phraseId === phrase.id);
}

function isVoiceTakePreviewPlaying(take: VoiceTake | null) {
  return Boolean(take && activeVoiceTakePreview.value?.takeId === take.id);
}

onMounted(() => {
  window.addEventListener("keydown", handleWindowKeydown);
  window.addEventListener("keyup", handleWindowKeyup);
  window.addEventListener("blur", resetModifierHoverState);
  window.addEventListener("pointerdown", handleWindowPointerDown);
});

onUnmounted(() => {
  window.removeEventListener("keydown", handleWindowKeydown);
  window.removeEventListener("keyup", handleWindowKeyup);
  window.removeEventListener("blur", resetModifierHoverState);
  window.removeEventListener("pointerdown", handleWindowPointerDown);
  for (const animationFrame of takePlaybackAnimationFrames.values()) {
    window.cancelAnimationFrame(animationFrame);
  }
  takePlaybackAnimationFrames.clear();
  for (const observer of pairedTextEditorResizeObservers.values()) {
    observer.disconnect();
  }
  pairedTextEditorResizeObservers.clear();
  dialogueInfoDescriptionResizeObserver?.disconnect();
  dialogueInfoDescriptionResizeObserver = null;
  stopActivePlayback();
  stopVoiceTakePreview();
  stopPhrasePreview();
  clearDialoguePreviewCache();
});

function isRowCollapsed(row: DialogueRow) {
  return collapsedRowIds.value.has(row.id);
}

function setActiveRow(row: DialogueRow) {
  emit("activate");
  activeRowId.value = row.id;
}

function activateDialogue() {
  emit("activate");
}

function isTakeAreaExpanded(row: DialogueRow) {
  return expandedTakeIds.value.has(row.id);
}

function toggleRow(row: DialogueRow) {
  const next = new Set(collapsedRowIds.value);
  if (next.has(row.id)) {
    next.delete(row.id);
  } else {
    next.add(row.id);
  }
  collapsedRowIds.value = next;
}

function toggleAllRows() {
  setAllRowsCollapsed(!allRowsCollapsed.value);
}

function toggleTakeArea(row: DialogueRow) {
  const next = new Set(expandedTakeIds.value);
  if (next.has(row.id)) {
    next.delete(row.id);
  } else {
    next.add(row.id);
  }
  expandedTakeIds.value = next;
}

function handleWindowPointerDown(event: PointerEvent) {
  if (event.target instanceof HTMLElement && event.target.closest("[data-pinyin-picker]")) return;
  pinyinPanelRowId.value = null;
}

function addRow() {
  const profile = profiles.value[0];
  const take = activeTakeForProfile(profile);
  const afterRowId = rows.value.some((row) => row.id === activeRowId.value) ? activeRowId.value : null;
  const label = `Line ${allRows.value.length + 1}`;
  void withSaving(() =>
    createDialogueRow({
      dialogueId: props.dialogue.id,
      roleLabel: label,
      voiceProfileId: profile?.id ?? null,
      voiceTakeId: take?.id ?? null,
      afterRowId,
      model: "qwen-base",
      language: profile?.language ?? "en",
      text: "",
      instructText: defaultCosyVoiceInstruct,
      cosyvoice: {
        useRefText: false,
        instructText: defaultCosyVoiceInstruct,
      },
    }),
  );
  emit("toast", "success", "Dialogue row added", label);
}

function duplicateRow(row: DialogueRow, event?: MouseEvent) {
  const appendToEnd = Boolean(event?.shiftKey);
  void withSaving(() =>
    createDialogueRow({
      dialogueId: props.dialogue.id,
      roleLabel: row.roleLabel,
      voiceProfileId: row.voiceProfileId ?? null,
      voiceTakeId: row.voiceTakeId ?? null,
      afterRowId: appendToEnd ? null : row.id,
      model: row.model,
      language: row.language,
      text: row.text,
      instructText: row.instructText ?? null,
      cosyvoice: { ...row.cosyvoice },
    }),
  );
  emit("toast", "success", "Dialogue row duplicated", appendToEnd ? `${row.roleLabel} copied to end` : row.roleLabel);
}

function updateRow(row: DialogueRow, payload: Parameters<typeof updateDialogueRow>[1]) {
  void withSaving(() => updateDialogueRow(row.id, payload));
}

async function saveRowTextDrafts(row: DialogueRow, options: { showSaving?: boolean } = {}) {
  const activeTakeIdAtSaveStart = row.activeTakeId;
  const text = dialogueTextValue(row);
  const instructText = cosyInstructValue(row);
  const payload: Parameters<typeof updateDialogueRow>[1] = {};

  if (text !== row.text) {
    payload.text = text;
  }
  if (instructText !== (row.cosyvoice.instructText ?? row.instructText ?? defaultCosyVoiceInstruct)) {
    payload.instructText = instructText;
    payload.cosyvoice = { ...row.cosyvoice, instructText };
  }

  if (!Object.keys(payload).length) return props.session;

  if (options.showSaving ?? true) {
    saving.value = true;
  }
  try {
    const session = await updateDialogueRow(row.id, payload);
    const sessionRow = allSessionRows(session).find((item) => item.id === row.id);
    const activeTakeIdAfterSave = sessionRow?.activeTakeId ?? rows.value.find((item) => item.id === row.id)?.activeTakeId;
    delete dialogueTextDrafts[row.id];
    delete cosyInstructDrafts[row.id];
    if (activeTakeIdAfterSave && activeTakeIdAfterSave !== activeTakeIdAtSaveStart) {
      const refreshedSession = await setActiveDialogueTake(row.id, activeTakeIdAfterSave);
      emit("session", refreshedSession);
      return refreshedSession;
    }
    emit("session", session);
    return session;
  } catch (error) {
    showError(error);
    return null;
  } finally {
    if (options.showSaving ?? true) {
      saving.value = false;
    }
  }
}

function saveDialogueTextDraft(row: DialogueRow, event: Event) {
  if (cancellingDialogueTextRows.delete(row.id)) {
    delete dialogueTextDrafts[row.id];
    if (activeDialogueTextRowId.value === row.id) {
      activeDialogueTextRowId.value = null;
    }
    return;
  }
  dialogueTextDrafts[row.id] = (event.target as HTMLTextAreaElement).value;
  if (activeDialogueTextRowId.value === row.id) {
    activeDialogueTextRowId.value = null;
  }
  void saveRowTextDrafts(row, { showSaving: false });
}

function saveCosyInstructDraft(row: DialogueRow, event: Event) {
  if (cancellingCosyInstructRows.delete(row.id)) {
    delete cosyInstructDrafts[row.id];
    return;
  }
  cosyInstructDrafts[row.id] = (event.target as HTMLTextAreaElement).value;
  void saveRowTextDrafts(row, { showSaving: false });
}

function cancelDialogueTextDraft(row: DialogueRow, event: KeyboardEvent) {
  const editor = event.currentTarget as HTMLTextAreaElement;
  cancellingDialogueTextRows.add(row.id);
  delete dialogueTextDrafts[row.id];
  editor.value = row.text;
  editor.blur();
}

function cancelCosyInstructDraft(row: DialogueRow, event: KeyboardEvent) {
  const editor = event.currentTarget as HTMLTextAreaElement;
  cancellingCosyInstructRows.add(row.id);
  delete cosyInstructDrafts[row.id];
  editor.value = row.cosyvoice.instructText ?? row.instructText ?? defaultCosyVoiceInstruct;
  editor.blur();
}

function rememberTextEditor(event: FocusEvent) {
  if (event.target instanceof HTMLTextAreaElement) {
    lastDialogueTextEditor.value = event.target;
  }
}

function rememberDialogueTextEditor(row: DialogueRow, event: FocusEvent) {
  rememberTextEditor(event);
  activeDialogueTextRowId.value = row.id;
}

function rememberCosyInstructEditor(event: FocusEvent) {
  rememberTextEditor(event);
  activeDialogueTextRowId.value = null;
}

function registerDialogueTextEditor(row: DialogueRow, element: unknown) {
  if (element instanceof HTMLTextAreaElement) {
    dialogueTextEditors.set(row.id, element);
    syncPairedTextEditorResizeObserver(row.id);
    return;
  }
  dialogueTextEditors.delete(row.id);
  syncPairedTextEditorResizeObserver(row.id);
}

function registerCosyInstructEditor(row: DialogueRow, element: unknown) {
  if (element instanceof HTMLTextAreaElement) {
    cosyInstructEditors.set(row.id, element);
    syncPairedTextEditorResizeObserver(row.id);
    return;
  }
  cosyInstructEditors.delete(row.id);
  syncPairedTextEditorResizeObserver(row.id);
}

function syncPairedTextEditorHeights(rowId: string, sourceEditor?: HTMLTextAreaElement) {
  if (syncingPairedTextEditorHeights.has(rowId)) return;
  const dialogueEditor = dialogueTextEditors.get(rowId);
  const cosyEditor = cosyInstructEditors.get(rowId);
  if (!dialogueEditor || !cosyEditor) return;

  syncingPairedTextEditorHeights.add(rowId);
  window.requestAnimationFrame(() => {
    const resizedEditor = sourceEditor ?? dialogueEditor;
    const nextHeight = resizedEditor.getBoundingClientRect().height;
    if (Number.isFinite(nextHeight) && nextHeight > 0) {
      const height = `${Math.round(nextHeight)}px`;
      dialogueEditor.style.height = height;
      cosyEditor.style.height = height;
    }
    syncingPairedTextEditorHeights.delete(rowId);
  });
}

function syncPairedTextEditorResizeObserver(rowId: string) {
  pairedTextEditorResizeObservers.get(rowId)?.disconnect();
  pairedTextEditorResizeObservers.delete(rowId);

  const dialogueEditor = dialogueTextEditors.get(rowId);
  const cosyEditor = cosyInstructEditors.get(rowId);
  if (!dialogueEditor || !cosyEditor || typeof ResizeObserver === "undefined") return;

  const observer = new ResizeObserver((entries) => {
    const resizedEditor = entries.find((entry) => entry.target instanceof HTMLTextAreaElement)?.target;
    syncPairedTextEditorHeights(rowId, resizedEditor instanceof HTMLTextAreaElement ? resizedEditor : undefined);
  });
  observer.observe(dialogueEditor);
  observer.observe(cosyEditor);
  pairedTextEditorResizeObservers.set(rowId, observer);
  syncPairedTextEditorHeights(rowId);
}

function insertDialogueTextToken(row: DialogueRow, token: string) {
  if (activeDialogueTextRowId.value !== row.id) return;
  const editor = dialogueTextEditors.get(row.id);
  if (!editor || document.activeElement !== editor) return;

  const currentText = dialogueTextValue(row);
  const selectionStart = editor.selectionStart ?? currentText.length;
  const selectionEnd = editor.selectionEnd ?? selectionStart;
  const nextText = `${currentText.slice(0, selectionStart)}${token}${currentText.slice(selectionEnd)}`;
  const nextCursor = selectionStart + token.length;
  dialogueTextDrafts[row.id] = nextText;

  void nextTick(() => {
    editor.focus();
    editor.setSelectionRange(nextCursor, nextCursor);
  });
}

function togglePinyinPanel(row: DialogueRow) {
  if (activeDialogueTextRowId.value !== row.id) return;
  pinyinPanelRowId.value = pinyinPanelRowId.value === row.id ? null : row.id;
}

function insertPinyinTone(row: DialogueRow, character: string) {
  insertDialogueTextToken(row, character);
}

function applyCosyInstructPreset(row: DialogueRow, preset: string) {
  if (row.model !== "cosyvoice3" || row.cosyvoice.useRefText || !preset.trim()) return;
  cosyInstructDrafts[row.id] = preset;
  const editor = cosyInstructEditors.get(row.id);
  void nextTick(() => {
    editor?.focus();
    editor?.setSelectionRange(preset.length, preset.length);
  });
}

function exitDialogueTextEditing() {
  const focusedEditor = document.activeElement instanceof HTMLTextAreaElement ? document.activeElement : null;
  const editor = focusedEditor ?? lastDialogueTextEditor.value;
  if (editor && document.contains(editor)) {
    editor.blur();
  }
}

function onProfileChange(row: DialogueRow, profileId: string) {
  const profile = findProfile(profileId);
  const take = activeTakeForProfile(profile);
  delete selectedPhraseIds[row.id];
  updateRow(row, {
    voiceProfileId: profile?.id ?? null,
    voiceTakeId: take?.id ?? null,
    language: profile?.language ?? row.language,
  });
}

function updateRoleLabel(row: DialogueRow, event: Event) {
  const roleLabel = (event.target as HTMLInputElement).value.trim() || row.roleLabel;
  if (roleLabel === row.roleLabel) return;
  updateRow(row, { roleLabel });
}

function updateTakeLabel(take: DialogueTake, event: Event) {
  const label = (event.target as HTMLInputElement).value.trim() || take.label;
  if (label === take.label) {
    delete takeLabelDrafts[take.id];
    return;
  }
  delete takeLabelDrafts[take.id];
  void withSaving(() => updateDialogueTake(take.id, { label }));
}

function updateActiveTakeText(row: DialogueRow) {
  const take = activeDialogueTake(row);
  if (!take) return;
  const text = dialogueTextValue(row).trim();
  if (!text) {
    emit("toast", "warning", "Dialogue text is empty", "Enter dialogue text before updating the active take.");
    return;
  }
  void withSaving(async () => {
    const session = await updateDialogueTake(take.id, { text });
    emit("toast", "success", "Active take text updated", take.label);
    return session;
  });
}

function confirmInlineEdit(event: KeyboardEvent) {
  (event.currentTarget as HTMLInputElement).blur();
}

function cancelTakeLabelEdit(take: DialogueTake, event: KeyboardEvent) {
  const input = event.currentTarget as HTMLInputElement;
  delete takeLabelDrafts[take.id];
  input.value = take.label;
  input.blur();
}

function setActiveTakeFromSelect(row: DialogueRow, event: Event) {
  const takeId = (event.target as HTMLSelectElement).value || null;
  const take = row.audioTakes.find((item) => item.id === takeId);
  void activateDialogueTake(row, take ?? null);
}

function setActiveTake(row: DialogueRow, take: DialogueTake) {
  if (row.activeTakeId === take.id) return;
  void activateDialogueTake(row, take);
}

async function activateDialogueTake(row: DialogueRow, take: DialogueTake | null) {
  saving.value = true;
  try {
    const session = await setActiveDialogueTake(row.id, take?.id ?? null);
    delete dialogueTextDrafts[row.id];
    delete cosyInstructDrafts[row.id];
    emit("session", session);
    if (take) {
      const message = missingReferenceMessage(take);
      if (message) {
        emit("toast", "warning", "Old generation reference missing", message);
      }
    }
  } catch (error) {
    showError(error);
  } finally {
    saving.value = false;
  }
}

function startRowDrag(row: DialogueRow, event: DragEvent) {
  if (searchActive.value) return;
  const mode = event.shiftKey ? "copy" : "move";
  draggedRowId.value = row.id;
  dragOverRowId.value = row.id;
  rowDragMode.value = mode;
  event.dataTransfer?.setData("text/plain", row.id);
  if (event.dataTransfer) {
    event.dataTransfer.effectAllowed = mode === "copy" ? "copy" : "move";
    event.dataTransfer.setData(
      rowDragMimeType,
      JSON.stringify({
        mode,
        sourceRowId: row.id,
        sourceDialogueId: props.dialogue.id,
      }),
    );
  }
}

function finishRowDrag() {
  draggedRowId.value = null;
  dragOverRowId.value = null;
  rowDragMode.value = null;
}

function dragOverRow(row: DialogueRow, event: DragEvent) {
  const payload = rowDragPayload(event);
  const hasRowDragData = Boolean(event.dataTransfer && Array.from(event.dataTransfer.types).includes(rowDragMimeType));
  const isCopyDrag = payload?.mode === "copy" || (!payload && hasRowDragData && event.shiftKey);
  if (isCopyDrag) {
    if (payload?.sourceRowId === row.id) return;
    event.preventDefault();
    dragOverRowId.value = row.id;
    rowDragMode.value = "copy";
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = "copy";
    }
    return;
  }

  if (!draggedRowId.value || draggedRowId.value === row.id || rowDragMode.value === "copy") return;
  if (props.dialogue.id !== payload?.sourceDialogueId && payload?.mode === "move") return;
  event.preventDefault();
  dragOverRowId.value = row.id;
  rowDragMode.value = "move";
  if (event.dataTransfer) {
    event.dataTransfer.dropEffect = "move";
  }
}

async function dropRow(targetRow: DialogueRow, event?: DragEvent) {
  const payload = event ? rowDragPayload(event) : null;
  const sourceRowId = payload?.sourceRowId ?? draggedRowId.value;
  const mode = payload?.mode ?? rowDragMode.value;
  finishRowDrag();
  if (!sourceRowId || sourceRowId === targetRow.id) return;

  if (mode === "copy") {
    const targetIndex = rows.value.findIndex((row) => row.id === targetRow.id);
    if (targetIndex < 0) return;
    saving.value = true;
    try {
      emit(
        "session",
        await duplicateDialogueRow({
          sourceRowId,
          targetDialogueId: props.dialogue.id,
          targetIndex,
        }),
      );
      emit("toast", "success", "Dialogue row duplicated", targetRow.roleLabel);
    } catch (error) {
      showError(error);
    } finally {
      saving.value = false;
    }
    return;
  }

  const sourceIndex = rows.value.findIndex((row) => row.id === sourceRowId);
  const targetIndex = rows.value.findIndex((row) => row.id === targetRow.id);
  if (sourceIndex < 0 || targetIndex < 0) return;

  const reordered = [...rows.value];
  const [movedRow] = reordered.splice(sourceIndex, 1);
  reordered.splice(targetIndex, 0, movedRow);
  const rowIds = reordered.map((row) => row.id);

  saving.value = true;
  try {
    emit("session", await reorderDialogueRows(rowIds, props.dialogue.id));
    emit("toast", "success", "Dialogue rows reordered");
  } catch (error) {
    showError(error);
  } finally {
    saving.value = false;
  }
}

function rowDragPayload(event: DragEvent): { mode: "move" | "copy"; sourceRowId: string; sourceDialogueId: string } | null {
  const transfer = event.dataTransfer;
  if (!transfer || !Array.from(transfer.types).includes(rowDragMimeType)) return null;
  try {
    const payload = JSON.parse(transfer.getData(rowDragMimeType)) as {
      mode?: unknown;
      sourceRowId?: unknown;
      sourceDialogueId?: unknown;
    };
    if (
      (payload.mode === "move" || payload.mode === "copy") &&
      typeof payload.sourceRowId === "string" &&
      typeof payload.sourceDialogueId === "string"
    ) {
      return {
        mode: payload.mode,
        sourceRowId: payload.sourceRowId,
        sourceDialogueId: payload.sourceDialogueId,
      };
    }
  } catch {
    return null;
  }
  return null;
}

function startTakeDrag(take: DialogueTake, event: DragEvent) {
  draggedTakeId.value = take.id;
  dragOverTakeId.value = take.id;
  event.dataTransfer?.setData("text/plain", take.id);
  if (event.dataTransfer) {
    event.dataTransfer.effectAllowed = "move";
  }
}

function finishTakeDrag() {
  draggedTakeId.value = null;
  dragOverTakeId.value = null;
}

function dragOverTake(take: DialogueTake, event: DragEvent) {
  if (!draggedTakeId.value || draggedTakeId.value === take.id) return;
  event.preventDefault();
  dragOverTakeId.value = take.id;
  if (event.dataTransfer) {
    event.dataTransfer.dropEffect = "move";
  }
}

async function dropTake(row: DialogueRow, targetTake: DialogueTake) {
  const sourceTakeId = draggedTakeId.value;
  finishTakeDrag();
  if (!sourceTakeId || sourceTakeId === targetTake.id) return;

  const sourceIndex = row.audioTakes.findIndex((take) => take.id === sourceTakeId);
  const targetIndex = row.audioTakes.findIndex((take) => take.id === targetTake.id);
  if (sourceIndex < 0 || targetIndex < 0) return;

  const reordered = [...row.audioTakes];
  const [movedTake] = reordered.splice(sourceIndex, 1);
  reordered.splice(targetIndex, 0, movedTake);
  const takeIds = reordered.map((take) => take.id);

  saving.value = true;
  try {
    emit("session", await reorderDialogueTakes(row.id, takeIds));
    emit("toast", "success", "Dialogue takes reordered", row.roleLabel);
  } catch (error) {
    showError(error);
  } finally {
    saving.value = false;
  }
}

function playActiveTake(row: DialogueRow) {
  if (!props.session) return;
  const take = activeDialogueTake(row);
  if (!take) return;
  const mountedAudio = takeAudioElements.get(take.id);
  if (mountedAudio) {
    toggleActiveTakePlayback(row, take);
    return;
  }
  const current = activePlayback.value;
  if (current?.rowId === row.id && current.takeId === take.id) {
    stopActivePlayback();
    return;
  }

  stopActivePlayback();
  const audio = new Audio(dialogueTakeAudioUrl(take));
  activePlayback.value = { rowId: row.id, takeId: take.id, audio };
  audio.addEventListener("ended", stopActivePlayback, { once: true });
  audio.addEventListener("error", () => {
    stopActivePlayback();
    reportMissingAudio(take);
  }, { once: true });
  audio.addEventListener("play", () => startTakePlaybackAnimation(take, audio));
  audio.addEventListener("pause", () => {
    stopTakePlaybackAnimation(take);
    markTakeStopped(take);
  });
  void audio.play();
}

function stopActivePlayback() {
  const current = activePlayback.value;
  if (!current) return;
  const row = rows.value.find((item) => item.id === current.rowId);
  const take = row?.audioTakes.find((item) => item.id === current.takeId);
  current.audio.pause();
  current.audio.currentTime = 0;
  if (take) {
    stopTakePlaybackAnimation(take);
    markTakeStopped(take);
    updateTakePlaybackState(take, current.audio);
  }
  activePlayback.value = null;
}

function isPlayingActiveTake(row: DialogueRow) {
  const take = activeDialogueTake(row);
  return Boolean(
    take &&
      ((activePlayback.value?.rowId === row.id && activePlayback.value.takeId === take.id) || playingTakeIds.value.has(take.id)),
  );
}

function multiTakesEditorRow() {
  return rows.value.find((row) => row.id === multiTakesEditorRowId.value) ?? null;
}

function openMultiTakesEditor(row: DialogueRow) {
  if (!row.audioTakes.length || !activeDialogueTake(row)) return;
  stopActivePlayback();
  multiTakesEditorRowId.value = row.id;
}

async function resetAudioEditorDock() {
  audioEditor.value = null;
  await nextTick();
}

async function openAudioEditor(row: DialogueRow, take: DialogueTake) {
  if (!props.session) return;
  stopActivePlayback();
  await resetAudioEditorDock();
  audioEditor.value = {
    kind: "take",
    sourceLabel: `${row.roleLabel} · ${take.label}`,
    audioSrc: dialogueTakeAudioUrl(take)!,
    rowLabel: row.roleLabel,
    takeId: take.id,
    takeLabel: take.label,
  };
}

async function openSourceAudioEditor(row: DialogueRow) {
  if (!props.session) return;
  stopActivePlayback();
  let sourceAudio = row.sourceAudio;
  let editorSession = props.session;
  if (!sourceAudio) {
    saving.value = true;
    try {
      editorSession = await createDialogueSourceAudioPlaceholder(row.id);
      emit("session", editorSession);
      sourceAudio = allSessionRows(editorSession).find((item) => item.id === row.id)?.sourceAudio ?? null;
      emit("toast", "info", "Source audio placeholder created", "Record or paste audio in AudioMass, then save to overwrite it.");
    } catch (error) {
      showError(error);
      return;
    } finally {
      saving.value = false;
    }
  }
  if (!sourceAudio) return;
  const audioSrc = audioUrl(editorSession.id, sourceAudio.filePath);
  await resetAudioEditorDock();
  audioEditor.value = {
    kind: "source",
    sourceLabel: `${row.roleLabel} · ${sourceAudio.label}`,
    audioSrc: sourceAudio.editedAt ? `${audioSrc}?v=${encodeURIComponent(sourceAudio.editedAt)}` : audioSrc,
    rowLabel: row.roleLabel,
    takeId: sourceAudio.id,
    takeLabel: sourceAudio.label,
  };
}

function openSourceAudioPicker(row: DialogueRow) {
  sourceUploadRowId.value = row.id;
  sourceAudioInput.value?.click();
}

async function uploadSourceAudio(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  const rowId = sourceUploadRowId.value;
  sourceUploadRowId.value = null;
  if (!file || !rowId) return;

  saving.value = true;
  try {
    emit("session", await uploadDialogueSourceAudio(rowId, file));
    emit("toast", "success", "Source audio loaded", file.name);
  } catch (error) {
    showError(error);
  } finally {
    saving.value = false;
  }
}

async function saveEditedAudio(payload: { takeId: string; blob: Blob; filename: string }) {
  if (audioEditor.value?.kind === "source") {
    await saveEditedSourceAudio(payload);
    return;
  }
  const beforeTake = rows.value.flatMap((row) => row.audioTakes).find((take) => take.id === payload.takeId);
  const previousBackupCount = beforeTake?.backupFilePaths?.length ?? 0;
  saving.value = true;
  try {
    const session = await overwriteDialogueTakeAudio(payload.takeId, payload.blob);
    emit("session", session);
    const nextTake = allSessionRows(session).flatMap((row) => row.audioTakes).find((take) => take.id === payload.takeId);
    const newBackupFilePath = nextTake?.backupFilePaths?.[previousBackupCount];
    if (nextTake && newBackupFilePath) {
      emit("undoAction", {
        id: crypto.randomUUID(),
        type: "dialogue-take-audio-overwrite",
        label: `Overwrite ${nextTake.label}`,
        createdAt: new Date().toISOString(),
        takeId: nextTake.id,
        undoBackupFilePath: newBackupFilePath,
      });
    }
    emit("toast", "success", "Edited audio saved", "Original take was backed up and the WAV was overwritten.");
  } catch (error) {
    showError(error);
  } finally {
    saving.value = false;
  }
}

async function saveEditedSourceAudio(payload: { takeId: string; blob: Blob; filename: string }) {
  const beforeSource = rows.value.map((row) => row.sourceAudio).find((source) => source?.id === payload.takeId);
  const previousBackupCount = beforeSource?.backupFilePaths?.length ?? 0;
  saving.value = true;
  try {
    const session = await overwriteDialogueSourceAudio(payload.takeId, payload.blob);
    emit("session", session);
    const nextSource = allSessionRows(session).map((row) => row.sourceAudio).find((source) => source?.id === payload.takeId);
    const newBackupFilePath = nextSource?.backupFilePaths?.[previousBackupCount];
    if (nextSource && newBackupFilePath) {
      emit("undoAction", {
        id: crypto.randomUUID(),
        type: "dialogue-source-audio-overwrite",
        label: `Overwrite source ${nextSource.label}`,
        createdAt: new Date().toISOString(),
        takeId: nextSource.id,
        undoBackupFilePath: newBackupFilePath,
      });
    }
    emit("toast", "success", "Source audio saved", "Original source audio was backed up and overwritten.");
  } catch (error) {
    showError(error);
  } finally {
    saving.value = false;
  }
}

function requestDeleteActiveTake(row: DialogueRow) {
  const take = activeDialogueTake(row);
  if (!take) return;
  requestDeleteTake(take);
}

function reportMissingAudio(take: DialogueTake) {
  const audio = takeAudioElements.get(take.id);
  if (audio && audio.readyState > HTMLMediaElement.HAVE_NOTHING) {
    clearMissingAudio(take);
    return;
  }
  const alreadyMissing = missingTakeIds.value.has(take.id);
  const next = new Set(missingTakeIds.value);
  next.add(take.id);
  missingTakeIds.value = next;
  if (alreadyMissing) return;
  emit("error", `Audio file for "${take.label}" is missing. Delete this take to remove the stale entry.`);
  emit("toast", "warning", "Audio file missing", `Delete "${take.label}" to remove the stale entry.`);
}

function isMissingAudio(take: DialogueTake) {
  return missingTakeIds.value.has(take.id);
}

function dialoguePreviewCacheKey() {
  const activeTakeParts = allRows.value
    .map((row) => {
      const take = activeDialogueTake(row);
      return take ? `${row.id}:${take.id}:${take.filePath}:${take.editedAt ?? ""}` : null;
    })
    .filter(Boolean);
  return `${props.dialogue.id}|${exportSilenceMs.value}|${activeTakeParts.join("|")}`;
}

function clearDialoguePreviewCache() {
  const current = dialoguePreviewCache.value;
  if (!current) return;
  current.audio.pause();
  URL.revokeObjectURL(current.url);
  dialoguePreviewCache.value = null;
  dialoguePreviewPlaying.value = false;
}

async function compiledDialoguePreviewAudio(forceRegenerate = false) {
  const key = dialoguePreviewCacheKey();
  const cached = dialoguePreviewCache.value;
  if (!forceRegenerate && cached?.key === key) return cached.audio;

  clearDialoguePreviewCache();
  compilingDialoguePreview.value = true;
  try {
    const { blob } = await downloadDialogueExport({
      dialogueId: props.dialogue.id,
      format: "wav",
      silenceMs: exportSilenceMs.value,
    });
    const url = URL.createObjectURL(blob);
    const audio = new Audio(url);
    audio.addEventListener("ended", () => {
      dialoguePreviewPlaying.value = false;
      audio.currentTime = 0;
    });
    audio.addEventListener("pause", () => {
      if (!audio.ended) dialoguePreviewPlaying.value = false;
    });
    audio.addEventListener("play", () => {
      dialoguePreviewPlaying.value = true;
    });
    dialoguePreviewCache.value = { key, url, audio };
    return audio;
  } finally {
    compilingDialoguePreview.value = false;
  }
}

async function toggleDialoguePreview(event: MouseEvent) {
  if (!canExport.value || compilingDialoguePreview.value) return;
  const cached = dialoguePreviewCache.value;
  if (cached?.audio && !cached.audio.paused && !event.shiftKey) {
    cached.audio.pause();
    return;
  }
  try {
    const audio = await compiledDialoguePreviewAudio(event.shiftKey);
    stopActivePlayback();
    stopVoiceTakePreview();
    await audio.play();
  } catch (error) {
    showError(error);
  }
}

async function exportDialogue() {
  if (!canExport.value || exporting.value) return;
  exporting.value = true;
  try {
    const { blob, filename } = await downloadDialogueExport({
      dialogueId: props.dialogue.id,
      format: exportFormat.value,
      silenceMs: exportSilenceMs.value,
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    link.click();
    URL.revokeObjectURL(url);
    emit("toast", "success", "Dialogue exported", filename);
  } catch (error) {
    showError(error);
  } finally {
    exporting.value = false;
  }
}

async function generateDialogueTake(row: DialogueRow) {
  if (generatingRowId.value) return;
  exitDialogueTextEditing();
  const text = dialogueTextValue(row);
  if (!row.voiceProfileId || !row.voiceTakeId) {
    emit("error", "Choose a voice profile and voice take before generating dialogue");
    return;
  }
  if (!text.trim()) {
    emit("error", "Dialogue text is required before generation");
    return;
  }
  const savedSession = await saveRowTextDrafts(row, { showSaving: true });
  if (!savedSession) return;

  generatingRowId.value = row.id;
  generationStatus.value = { ...generationStatus.value, [row.id]: "Queued for dialogue" };
  generationErrors.value = { ...generationErrors.value, [row.id]: "" };
  try {
    const job = await createDialogueJob({ rowId: row.id });
    let currentJob = job;
    while (currentJob.status === "queued" || currentJob.status === "running") {
      generationStatus.value = {
        ...generationStatus.value,
        [row.id]:
          currentJob.message || (currentJob.status === "queued" ? "Queued for dialogue" : "Generating dialogue audio"),
      };
      await new Promise((resolve) => window.setTimeout(resolve, 1500));
      currentJob = await getJob(currentJob.id);
    }

    if (currentJob.status === "failed") {
      throw new Error(currentJob.error || "Dialogue generation failed");
    }
    if (currentJob.result?.session) {
      emit("session", await getSession());
      generationStatus.value = { ...generationStatus.value, [row.id]: "Take saved" };
      emit("toast", "success", "Dialogue take generated", `${row.roleLabel} has a new active take.`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Dialogue generation failed";
    generationErrors.value = { ...generationErrors.value, [row.id]: message };
    showError(error);
  } finally {
    window.setTimeout(() => {
      const next = { ...generationStatus.value };
      delete next[row.id];
      generationStatus.value = next;
    }, 1200);
    generatingRowId.value = null;
  }
}

async function insertSelectedPhrase(row: DialogueRow) {
  const phrase = selectedPhrase(row);
  if (!phrase) {
    emit("toast", "warning", "No phrase selected", "Load a phrase on the selected voice profile first.");
    return;
  }
  saving.value = true;
  try {
    emit("session", await createDialogueTakeFromPhrase(row.id, phrase.id));
    emit("toast", "success", "Phrase inserted", `${phrase.label} was added as the active take.`);
  } catch (error) {
    showError(error);
  } finally {
    saving.value = false;
  }
}

async function convertDialogueTake(row: DialogueRow, sourceTake?: DialogueTake) {
  if (generatingRowId.value || convertingRowId.value || convertingTakeId.value) return;
  if (row.model !== "cosyvoice3") {
    emit("error", "Voice conversion uses CosyVoice3. Choose CosyVoice3 for this row.");
    return;
  }
  if (!sourceTake && !row.sourceAudio) {
    emit("error", "Load source audio before voice conversion");
    return;
  }
  if (!row.voiceProfileId || !row.voiceTakeId) {
    emit("error", "Choose a target voice profile and voice take before conversion");
    return;
  }

  convertingRowId.value = row.id;
  convertingTakeId.value = sourceTake?.id ?? null;
  generationStatus.value = { ...generationStatus.value, [row.id]: "Queued for voice conversion" };
  generationErrors.value = { ...generationErrors.value, [row.id]: "" };
  try {
    const job = await createDialogueConversionJob({ rowId: row.id, sourceTakeId: sourceTake?.id ?? null });
    let currentJob = job;
    while (currentJob.status === "queued" || currentJob.status === "running") {
      generationStatus.value = {
        ...generationStatus.value,
        [row.id]:
          currentJob.message || (currentJob.status === "queued" ? "Queued for voice conversion" : "Converting voice"),
      };
      await new Promise((resolve) => window.setTimeout(resolve, 1500));
      currentJob = await getJob(currentJob.id);
    }

    if (currentJob.status === "failed") {
      throw new Error(currentJob.error || "Voice conversion failed");
    }
    if (currentJob.result?.session) {
      emit("session", await getSession());
      generationStatus.value = { ...generationStatus.value, [row.id]: "Converted take saved" };
      emit(
        "toast",
        "success",
        "Voice converted",
        sourceTake
          ? `${sourceTake.label} was converted into a new active take.`
          : `${row.roleLabel} has a new active converted take.`,
      );
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Voice conversion failed";
    generationErrors.value = { ...generationErrors.value, [row.id]: message };
    showError(error);
  } finally {
    window.setTimeout(() => {
      const next = { ...generationStatus.value };
      delete next[row.id];
      generationStatus.value = next;
    }, 1200);
    convertingRowId.value = null;
    convertingTakeId.value = null;
  }
}

function requestDeleteRow(row: DialogueRow) {
  deleteTarget.value = { type: "row", row };
}

function requestDeleteTake(take: DialogueTake) {
  deleteTarget.value = { type: "take", take };
}

function requestDeleteDialogueInfoMedia(media: Dialogue["info"]["media"][number]) {
  deleteTarget.value = { type: "media", media };
}

function requestDeleteDialogue() {
  if (!canDeleteDialogue.value) return;
  deleteTarget.value = { type: "dialogue" };
}

function requestClearDialogue() {
  if (!allRows.value.length) return;
  deleteTarget.value = { type: "clear" };
}

function emitDialogueRowDeleteUndo(result: { dialogueId: string; row: DialogueRow; index: number }) {
  emit("undoAction", {
    id: crypto.randomUUID(),
    type: "dialogue-row-delete",
    label: `Delete ${result.row.roleLabel}`,
    createdAt: new Date().toISOString(),
    dialogueId: result.dialogueId,
    row: result.row,
    index: result.index,
  });
}

async function confirmDelete() {
  const target = deleteTarget.value;
  if (!target) return;
  deleteTarget.value = null;
  if (target.type === "row") {
    saving.value = true;
    try {
      const result = await deleteDialogueRow(target.row.id);
      emit("session", result.session);
      emitDialogueRowDeleteUndo(result);
      emit("toast", "success", "Dialogue row deleted", target.row.roleLabel);
    } catch (error) {
      showError(error);
    } finally {
      saving.value = false;
    }
    return;
  }

  if (target.type === "dialogue") {
    saving.value = true;
    try {
      emit("session", await deleteDialogue(props.dialogue.id));
      emit("toast", "success", "Dialogue deleted", props.dialogue.name);
    } catch (error) {
      showError(error);
    } finally {
      saving.value = false;
    }
    return;
  }

  if (target.type === "clear") {
    saving.value = true;
    try {
      const rowsToDelete = [...allRows.value];
      for (const row of rowsToDelete) {
        const result = await deleteDialogueRow(row.id);
        emit("session", result.session);
        emitDialogueRowDeleteUndo(result);
      }
      emit("toast", "success", "Dialogue cleared", `${rowsToDelete.length} row${rowsToDelete.length === 1 ? "" : "s"} deleted`);
    } catch (error) {
      showError(error);
    } finally {
      saving.value = false;
    }
    return;
  }

  if (target.type === "media") {
    saving.value = true;
    try {
      const result = await deleteDialogueInfoMedia(props.dialogue.id, target.media.id);
      emit("session", result.session);
      if (fullscreenDialogueInfoMediaId.value === target.media.id) fullscreenDialogueInfoMediaId.value = null;
      emit("undoAction", {
        id: crypto.randomUUID(),
        type: "dialogue-info-media-delete",
        label: `Delete ${result.media.filename}`,
        createdAt: new Date().toISOString(),
        dialogueId: result.dialogueId,
        media: result.media,
        index: result.index,
      });
      emit("toast", "success", "Media deleted", result.media.filename);
    } catch (error) {
      showError(error);
    } finally {
      saving.value = false;
    }
    return;
  }

  saving.value = true;
  try {
    const result = await deleteDialogueTake(target.take.id);
    emit("session", result.session);
    emit("undoAction", {
      id: crypto.randomUUID(),
      type: "dialogue-take-delete",
      label: `Delete ${result.take.label}`,
      createdAt: new Date().toISOString(),
      rowId: result.rowId,
      take: result.take,
      index: result.index,
      activeTakeIdBefore: result.activeTakeIdBefore,
    });
    emit("toast", "success", "Dialogue take deleted", target.take.label);
  } catch (error) {
    showError(error);
    saving.value = false;
    return;
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <section class="relative rounded-lg border border-[#2b2b2b] bg-[#202020]" @pointerdown="activateDialogue">
    <span
      v-if="props.active"
      class="absolute left-[3rem] top-1 rounded-sm border border-emerald-700/60 bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase leading-none tracking-wide text-emerald-300"
    >
      active
    </span>
    <div class="grid grid-cols-[44px_minmax(0,1fr)] border-b border-[#2b2b2b]">
      <div class="border-r border-[#2b2b2b] bg-[#181818] px-1 py-4">
        <button
          class="mx-auto grid size-8 place-items-center rounded-md text-zinc-400 hover:bg-[#2b2b2b] hover:text-zinc-100 disabled:cursor-not-allowed disabled:text-zinc-600"
          type="button"
          :disabled="!rows.length"
          :title="allRowsCollapsed ? 'Expand all dialogue rows' : 'Collapse all dialogue rows'"
          :aria-label="allRowsCollapsed ? 'Expand all dialogue rows' : 'Collapse all dialogue rows'"
          @click="toggleAllRows"
        >
          <ChevronDown v-if="allRowsCollapsed" class="size-4" />
          <ChevronUp v-else class="size-4" />
        </button>
      </div>
      <div class="flex flex-wrap items-center justify-between gap-4 px-5 py-4">
        <div class="flex min-w-0 flex-1 items-center gap-2">
          <input
            v-if="editingDialogueName"
            v-model="dialogueNameDraft"
            class="h-8 w-[26rem] max-w-full rounded-md border border-[#38383d] bg-[#181818] px-2 text-base font-semibold text-zinc-100 outline-none focus:ring-1 focus:ring-inset focus:ring-emerald-700/70"
            type="text"
            @blur="saveDialogueName"
            @keydown.enter.prevent="saveDialogueName"
            @keydown.escape.prevent="cancelDialogueNameEdit"
          />
          <button
            v-else
            class="h-8 max-w-[32rem] truncate rounded-md px-2 text-left text-base font-semibold text-zinc-100 hover:bg-[#2b2b2b] focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-emerald-700/70"
            type="button"
            title="Rename dialogue"
            @click="startDialogueNameEdit"
          >
            {{ props.dialogue.name }}
          </button>
          <button
            class="grid size-8 place-items-center rounded-md border border-[#38383d] text-zinc-300 hover:border-emerald-700/70 hover:bg-emerald-500/10 hover:text-emerald-300"
            type="button"
            :title="rowsHiddenToggleTitle"
            :aria-label="rowsHiddenToggleLabel"
            @click="toggleRowsHidden"
          >
            <Eye v-if="rowsHidden" class="size-4" />
            <EyeClosed v-else class="size-4" />
          </button>
          <button
            class="inline-flex h-8 items-center gap-2 rounded-md border px-2 text-xs font-medium"
            :class="
              infoVisible
                ? 'border-emerald-700/70 bg-emerald-500/10 text-emerald-300'
                : 'border-[#38383d] text-zinc-300 hover:border-emerald-700/70 hover:bg-emerald-500/10 hover:text-emerald-300'
            "
            type="button"
            :title="infoVisibleToggleTitle"
            :aria-label="infoVisibleToggleLabel"
            :aria-pressed="infoVisible"
            @click="toggleInfoVisible"
          >
            <Info class="size-3.5" />
            Info
          </button>
          <button
            class="inline-flex h-8 items-center gap-2 rounded-md border border-[#38383d] px-2 text-xs font-medium text-zinc-300 hover:border-emerald-700/70 hover:bg-emerald-500/10 hover:text-emerald-300"
            type="button"
            :disabled="saving"
            @click="addDialogue"
          >
            <Plus class="size-3.5" />
            Dialogue
          </button>
          <button
            class="inline-flex h-8 items-center gap-2 rounded-md border border-[#38383d] px-2 text-xs font-medium text-zinc-300 hover:border-red-400/70 hover:bg-red-500/10 hover:text-red-200 disabled:cursor-not-allowed disabled:border-[#38383d] disabled:text-zinc-600"
            type="button"
            :disabled="saving || !canDeleteDialogue"
            :title="canDeleteDialogue ? 'Delete this dialogue' : 'At least one dialogue must remain'"
            @click="requestDeleteDialogue"
          >
            <Trash2 class="size-3.5" />
            Delete
          </button>
          <button
            class="inline-flex h-8 items-center gap-2 rounded-md border border-[#38383d] px-2 text-xs font-medium text-zinc-300 hover:border-red-400/70 hover:bg-red-500/10 hover:text-red-200 disabled:cursor-not-allowed disabled:border-[#38383d] disabled:text-zinc-600"
            type="button"
            :disabled="saving || !rows.length"
            title="Clear all rows in this dialogue"
            @click="requestClearDialogue"
          >
            <Trash class="size-3.5" />
            Clear
          </button>
          <button
            class="grid size-8 place-items-center rounded-md border border-[#38383d] text-zinc-300 hover:bg-[#2b2b2b] disabled:cursor-not-allowed disabled:text-zinc-500"
            :class="isDialoguePreviewRegenerateMode() ? 'border-indigo-500/70 bg-indigo-600 text-white hover:bg-indigo-500 disabled:text-indigo-200' : ''"
            type="button"
            :disabled="!canExport || compilingDialoguePreview"
            :title="canExport ? 'Play compiled dialogue preview. Shift-click to regenerate preview audio.' : 'At least one dialogue row needs an active take before preview.'"
            aria-label="Play compiled dialogue preview"
            @mouseenter="dialoguePreviewHover = true"
            @mouseleave="dialoguePreviewHover = false"
            @click="toggleDialoguePreview"
          >
            <LoaderCircle v-if="compilingDialoguePreview" class="size-3.5 animate-spin" />
            <Pause v-else-if="dialoguePreviewPlaying" class="size-3.5" />
            <Play v-else class="size-3.5" />
          </button>
        </div>
      <div class="flex flex-wrap items-center justify-end gap-1.5">
        <label class="grid w-16 gap-0.5 text-[10px] leading-none text-zinc-500">
          <span class="text-center text-[10px] leading-none text-zinc-300">
            {{ exportSilenceMs }}ms
          </span>
          <input
            v-model.number="exportSilenceMs"
            class="silence-range h-3 w-16"
            max="2000"
            min="0"
            step="50"
            type="range"
          />
        </label>
        <div class="relative">
          <select
            v-model="exportFormat"
            class="h-8 appearance-none rounded-md border border-[#38383d] bg-[#181818] pl-2 pr-7 text-xs text-zinc-200 outline-none focus:ring-1 focus:ring-inset focus:ring-emerald-700/70"
          >
            <option value="wav">WAV</option>
            <option value="mp3-v0">MP3 V0</option>
          </select>
          <ChevronDown class="pointer-events-none absolute right-2 top-2 size-3.5 text-zinc-500" />
        </div>
        <button
          class="inline-flex h-8 items-center gap-1.5 rounded-md border border-[#38383d] px-2 text-xs text-zinc-300 hover:bg-[#2b2b2b] disabled:cursor-not-allowed disabled:text-zinc-500"
          type="button"
          :disabled="exporting || !canExport"
          :title="canExport ? 'Export rows with active takes in row order. Rows without takes are skipped.' : 'At least one dialogue row needs an active take before export.'"
          @click="exportDialogue"
        >
          <LoaderCircle v-if="exporting" class="size-3.5 animate-spin" />
          <Download v-else class="size-3.5" />
          {{ exporting ? "Exporting" : "Export" }}
        </button>
        <button
          v-if="!rowsHidden"
          class="inline-flex h-8 items-center gap-1.5 rounded-md bg-emerald-600 px-2.5 text-xs font-medium text-white hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-50"
          type="button"
          :disabled="saving"
          @click="addRow"
        >
          <Plus class="size-3.5" />
          Row
        </button>
      </div>
      </div>
    </div>

    <div v-if="infoVisible" class="border-t border-[#2b2b2b] bg-[#1b1b1b] px-6 py-4">
      <div class="grid gap-3">
        <textarea
          ref="dialogueInfoDescriptionEditor"
          v-model="dialogueInfoDescriptionDraft"
          class="min-h-28 resize-y rounded-md border border-[#38383d] bg-[#181818] px-3 py-2 text-sm leading-6 text-zinc-200 outline-none placeholder:text-zinc-600 focus:ring-1 focus:ring-inset focus:ring-emerald-700/70"
          placeholder="Mood, background, tempo, emotion, scene context..."
          :style="{ height: `${dialogueInfoDescriptionHeight}px` }"
        />
        <div
          class="grid gap-2 rounded-md border border-transparent p-2"
          :class="dialogueInfoMediaDragActive ? 'border-emerald-700/70 bg-emerald-500/10' : dialogueInfoMedia.length ? 'bg-[#181818]/40' : ''"
          @dragenter.prevent="dialogueInfoMediaDragActive = true"
          @dragover.prevent="dialogueInfoMediaDragActive = true"
          @dragleave.prevent="dialogueInfoMediaDragActive = false"
          @drop.prevent="dropDialogueInfoMedia"
        >
          <div v-if="dialogueInfoMedia.length" class="flex items-center justify-between gap-3">
            <span class="text-xs font-medium uppercase tracking-wide text-zinc-500">Media</span>
            <div class="flex items-center gap-1">
              <button
                class="grid size-8 place-items-center rounded-md border border-[#38383d] text-zinc-300 hover:bg-[#2b2b2b] disabled:cursor-not-allowed disabled:text-zinc-600"
                type="button"
                title="Reduce thumbnail size"
                :disabled="dialogueInfoMediaThumbnailSize <= 96"
                @click="resizeDialogueInfoMediaThumbnails(-32)"
              >
                <Minus class="size-3.5" />
              </button>
              <button
                class="grid size-8 place-items-center rounded-md border border-[#38383d] text-zinc-300 hover:bg-[#2b2b2b] disabled:cursor-not-allowed disabled:text-zinc-600"
                type="button"
                title="Enlarge thumbnail size"
                :disabled="dialogueInfoMediaThumbnailSize >= 360"
                @click="resizeDialogueInfoMediaThumbnails(32)"
              >
                <Plus class="size-3.5" />
              </button>
            </div>
          </div>
          <div v-if="dialogueInfoMedia.length" class="flex flex-wrap gap-3">
            <figure
              v-for="media in dialogueInfoMedia"
              :key="media.id"
              class="group relative overflow-hidden rounded-md border border-[#38383d] bg-[#111111]"
              :style="{ width: `${dialogueInfoMediaThumbnailSize}px` }"
            >
              <div class="relative aspect-video">
                <img
                  v-if="media.kind === 'image'"
                  class="size-full object-cover"
                  :src="dialogueInfoMediaUrl(media.filePath)"
                  :alt="media.filename"
                  loading="lazy"
                />
                <video
                  v-else
                  :ref="(element) => registerDialogueInfoMediaVideo(media.id, element)"
                  class="size-full object-cover"
                  :src="dialogueInfoMediaUrl(media.filePath)"
                  playsinline
                  preload="metadata"
                  @loadedmetadata="updateDialogueInfoMediaVideoState(media.id, $event)"
                  @timeupdate="updateDialogueInfoMediaVideoState(media.id, $event)"
                  @play="updateDialogueInfoMediaVideoState(media.id, $event)"
                  @pause="updateDialogueInfoMediaVideoState(media.id, $event)"
                  @volumechange="updateDialogueInfoMediaVideoState(media.id, $event)"
                />
                <div
                  v-if="media.kind === 'video'"
                  class="absolute inset-x-0 bottom-0 flex items-center gap-1 bg-black/70 px-0 py-0 text-white backdrop-blur-sm"
                  :class="compactDialogueInfoMediaControls ? 'h-5' : 'h-6'"
                >
                  <button
                    class="grid shrink-0 place-items-center rounded text-white hover:bg-white/10"
                    :class="compactDialogueInfoMediaControls ? 'size-5' : 'size-5'"
                    type="button"
                    title="Play or pause video"
                    @click="toggleDialogueInfoMediaVideoPlayback(media.id)"
                  >
                    <Play v-if="dialogueInfoMediaVideoStatus(media.id).paused" :class="compactDialogueInfoMediaControls ? 'size-3' : 'size-3.5'" />
                    <Pause v-else :class="compactDialogueInfoMediaControls ? 'size-3' : 'size-3.5'" />
                  </button>
                  <span class="shrink-0 font-mono text-[10px] tabular-nums text-zinc-100">
                    {{ formatCompactMediaTime(dialogueInfoMediaVideoStatus(media.id).currentTime) }}
                  </span>
                  <input
                    v-if="!compactDialogueInfoMediaControls"
                    class="dialogue-info-thumbnail-video-range min-w-0 flex-1"
                    type="range"
                    min="0"
                    :max="dialogueInfoMediaVideoStatus(media.id).duration || 0"
                    step="0.1"
                    :value="dialogueInfoMediaVideoStatus(media.id).currentTime"
                    title="Seek video"
                    @input="seekDialogueInfoMediaVideo(media.id, $event)"
                  />
                  <button
                    class="grid shrink-0 place-items-center rounded text-white hover:bg-white/10"
                    :class="compactDialogueInfoMediaControls ? 'size-5' : 'size-5'"
                    type="button"
                    title="Mute or unmute video"
                    @click="toggleDialogueInfoMediaVideoMuted(media.id)"
                  >
                    <VolumeX v-if="dialogueInfoMediaVideoStatus(media.id).muted" :class="compactDialogueInfoMediaControls ? 'size-3' : 'size-3.5'" />
                    <Volume2 v-else :class="compactDialogueInfoMediaControls ? 'size-3' : 'size-3.5'" />
                  </button>
                </div>
                <button
                  class="absolute left-1.5 top-1.5 grid size-7 place-items-center rounded-md border border-black/50 bg-black/70 text-red-200 opacity-90 hover:bg-red-950 disabled:cursor-not-allowed disabled:opacity-50"
                  type="button"
                  title="Delete media"
                  :disabled="saving"
                  @click="requestDeleteDialogueInfoMedia(media)"
                >
                  <Trash2 class="size-3.5" />
                </button>
                <button
                  class="absolute right-1.5 top-1.5 grid size-7 place-items-center rounded-md border border-black/50 bg-black/70 text-zinc-100 opacity-90 hover:bg-black"
                  type="button"
                  title="Open fullscreen preview"
                  @click="fullscreenDialogueInfoMediaId = media.id"
                >
                  <Maximize2 class="size-3.5" />
                </button>
              </div>
              <figcaption class="truncate px-2 py-1 text-[11px] text-zinc-400" :title="media.filename">
                {{ media.filename }}
              </figcaption>
            </figure>
          </div>
          <p v-else class="rounded-md border border-dashed border-[#38383d] px-3 py-4 text-center text-xs text-zinc-500">
            Drop image or video media here
          </p>
        </div>
        <div class="flex flex-wrap items-center justify-between gap-3">
          <input
            ref="dialogueInfoMediaInput"
            class="hidden"
            type="file"
            multiple
            :accept="dialogueInfoMediaAccept"
            @change="selectDialogueInfoMedia"
          />
          <button
            class="inline-flex h-8 items-center gap-2 rounded-md border px-2 text-xs font-medium"
            :class="
              dialogueInfoMediaDragActive
                ? 'border-emerald-700/70 bg-emerald-500/10 text-emerald-300'
                : 'border-[#38383d] text-zinc-300 hover:bg-[#2b2b2b]'
            "
            type="button"
            :disabled="dialogueInfoMediaUploading"
            title="Upload image/video media"
            @click="dialogueInfoMediaInput?.click()"
          >
            <LoaderCircle v-if="dialogueInfoMediaUploading" class="size-3.5 animate-spin" />
            <Upload v-else class="size-3.5" />
            {{ dialogueInfoMediaUploading ? "Uploading" : "Upload media" }}
          </button>
          <div class="flex items-center gap-2">
            <button
              class="h-8 rounded-md border border-[#38383d] px-3 text-xs font-medium text-zinc-300 hover:bg-[#2b2b2b] disabled:cursor-not-allowed disabled:text-zinc-600"
              type="button"
              :disabled="saving || !dialogueInfoDescriptionChanged"
              @click="cancelDialogueInfoDescriptionEdit"
            >
              Cancel
            </button>
            <button
              class="h-8 rounded-md bg-emerald-600 px-3 text-xs font-semibold text-white hover:bg-emerald-500 disabled:cursor-not-allowed disabled:bg-zinc-700 disabled:text-zinc-400"
              type="button"
              :disabled="saving || !dialogueInfoDescriptionChanged"
              @click="saveDialogueInfoDescription"
            >
              Save
            </button>
          </div>
        </div>
      </div>
    </div>

    <div v-if="rowsHidden && !searchActive" class="border-t border-[#2b2b2b] px-6 py-3 text-sm text-zinc-500">
      {{ allRows.length }} dialogue row{{ allRows.length === 1 ? "" : "s" }} hidden
    </div>

    <div v-else-if="rows.length" class="divide-y divide-[#2b2b2b]">
      <article
        v-for="(row, index) in rows"
        :key="row.id"
        class="grid grid-cols-[44px_minmax(0,1fr)] gap-0"
        :class="[
          draggedRowId === row.id ? 'opacity-50' : '',
          dragOverRowId === row.id && draggedRowId !== row.id && rowDragMode === 'move' ? 'ring-1 ring-inset ring-emerald-700/70' : '',
          dragOverRowId === row.id && draggedRowId !== row.id && rowDragMode === 'copy' ? 'ring-1 ring-inset ring-indigo-500/80' : '',
        ]"
        @focusin="setActiveRow(row)"
        @pointerdown="setActiveRow(row)"
        @dragover="dragOverRow(row, $event)"
        @drop.prevent="dropRow(row, $event)"
      >
        <div
          class="grid grid-cols-[14px_minmax(0,1fr)] border-r border-[#2b2b2b] bg-[#181818] text-center text-xs text-zinc-500"
          :class="isRowCollapsed(row) ? 'py-1.5' : 'py-4'"
        >
          <button
            class="grid h-full min-h-8 w-3.5 cursor-grab place-items-center rounded-sm text-zinc-500 hover:bg-[#2b2b2b] hover:text-zinc-200 active:cursor-grabbing disabled:cursor-not-allowed disabled:text-zinc-700"
            :class="isRowDuplicateHandleMode(row) ? 'bg-indigo-600 text-white hover:bg-indigo-500' : ''"
            type="button"
            draggable="true"
            title="Drag to reorder. Hold Shift while dragging to duplicate."
            aria-label="Drag to reorder row"
            :disabled="saving || searchActive"
            @mouseenter="setRowDuplicateHover(row, true)"
            @mouseleave="setRowDuplicateHover(row, false)"
            @dragstart="startRowDrag(row, $event)"
            @dragend="finishRowDrag"
          >
            <GripVertical class="h-5 w-3" />
          </button>
          <div class="min-w-0 -ml-0.5">
          <button
            class="mx-auto grid place-items-center overflow-hidden rounded text-zinc-400 hover:bg-[#2b2b2b] hover:text-zinc-100"
            :class="isRowCollapsed(row) ? 'size-5' : 'size-6'"
            type="button"
            :aria-label="isRowCollapsed(row) ? 'Expand row' : 'Collapse row'"
            @click="toggleRow(row)"
          >
            <ChevronDown v-if="isRowCollapsed(row)" class="size-4" />
            <ChevronUp v-else class="size-4" />
          </button>
          <span class="block" :class="isRowCollapsed(row) ? 'mt-0.5' : 'mt-1'">{{ index + 1 }}</span>
          </div>
        </div>

        <div
          v-if="isRowCollapsed(row)"
          class="relative grid grid-cols-[minmax(0,1fr)_180px_auto_auto_auto_auto] items-center gap-1 border-l px-4 py-2 transition-shadow"
          :class="activeRowId === row.id ? 'ring-1 ring-inset ring-emerald-700/70' : ''"
          :style="{ borderLeftColor: voiceProfileColor(row) }"
        >
          <div class="pointer-events-none absolute left-px top-px z-10 flex max-w-[50%] items-center gap-px overflow-hidden p-px text-[12px] leading-none text-zinc-500">
            <span class="max-w-44 truncate bg-[#202020]/90 px-px">{{ voiceProfileLabel(row) }}</span>
            <span
              v-for="tag in voiceProfileTags(row).slice(0, 4)"
              :key="tag"
              class="max-w-28 truncate bg-[#202020]/90 px-px text-zinc-600"
            >
              {{ tag }}
            </span>
            <span class="max-w-36 truncate bg-[#202020]/90 px-px text-zinc-500">{{ row.roleLabel }}</span>
          </div>
          <p class="min-w-0 truncate pt-2 text-sm text-zinc-200">
            {{ row.text || row.roleLabel }}
          </p>
          <span class="truncate text-sm text-zinc-400">
            {{ activeDialogueTake(row)?.label || "No take" }}
          </span>
          <button
            class="grid size-8 place-items-center rounded-md border border-[#38383d] text-zinc-300 hover:bg-[#2b2b2b] disabled:cursor-not-allowed disabled:text-zinc-500"
            type="button"
            :disabled="!activeDialogueTake(row)"
            title="Edit audio"
            aria-label="Edit active take audio"
            @click="activeDialogueTake(row) && openAudioEditor(row, activeDialogueTake(row)!)"
          >
            <AudioLines class="size-4" />
          </button>
          <button
            class="inline-flex h-8 w-20 items-center justify-center gap-1.5 rounded-md border border-[#38383d] px-2 text-sm text-zinc-300 hover:bg-[#2b2b2b] disabled:cursor-not-allowed disabled:text-zinc-500"
            type="button"
            :disabled="!activeDialogueTake(row)"
            @click="playActiveTake(row)"
          >
            <Square v-if="isPlayingActiveTake(row)" class="size-3.5" />
            <Play v-else class="size-3.5" />
            {{ isPlayingActiveTake(row) ? "Stop" : "Play" }}
          </button>
          <button
            class="grid size-7 place-items-center rounded-md text-zinc-300 hover:bg-[#2b2b2b]"
            :class="isDuplicateAppendMode(row) ? 'bg-indigo-600 text-white hover:bg-indigo-500' : ''"
            type="button"
            title="Duplicate row. Shift-click to copy to the end."
            aria-label="Duplicate row"
            @mouseenter="setDuplicateAppendHover(row, true)"
            @mouseleave="setDuplicateAppendHover(row, false)"
            @click="duplicateRow(row, $event)"
          >
            <CopyPlus class="size-3.5" />
          </button>
          <button
            class="grid size-7 place-items-center rounded-md text-red-300 hover:bg-red-500/10"
            type="button"
            title="Delete row"
            @click="requestDeleteRow(row)"
          >
            <Trash2 class="size-3.5" />
          </button>
        </div>

        <div
          v-else
          class="grid gap-4 border-l p-4 transition-shadow"
          :class="activeRowId === row.id ? 'ring-1 ring-inset ring-emerald-700/70' : ''"
          :style="{ borderLeftColor: voiceProfileColor(row) }"
        >
          <div class="grid grid-cols-[140px_180px_160px_120px_120px_minmax(140px,180px)_auto] items-end gap-3">
            <label class="grid gap-1 text-xs text-zinc-500">
              Role
              <input
                class="h-9 min-w-0 rounded-md border border-[#38383d] bg-[#181818] px-2 text-sm text-zinc-100 outline-none focus:ring-1 focus:ring-inset focus:ring-emerald-700/70"
                :value="row.roleLabel"
                @blur="updateRoleLabel(row, $event)"
                @keydown.enter.prevent="confirmInlineEdit"
              />
            </label>

            <label class="grid gap-1 text-xs text-zinc-500">
              Voice profile
              <select
                class="h-9 min-w-0 rounded-md border border-[#38383d] bg-[#181818] px-2 text-sm text-zinc-100 outline-none focus:ring-1 focus:ring-inset focus:ring-emerald-700/70 disabled:cursor-not-allowed disabled:text-zinc-500"
                :value="row.voiceProfileId || ''"
                :disabled="!profiles.length"
                @change="onProfileChange(row, ($event.target as HTMLSelectElement).value)"
              >
                <option v-for="profile in profiles" :key="profile.id" :value="profile.id">
                  {{ profile.name }}
                </option>
              </select>
            </label>

            <label class="grid gap-1 text-xs text-zinc-500">
              <span class="flex items-center gap-1.5">
                <span>Voice take</span>
                <button
                  class="grid size-4 place-items-center rounded p-0 text-zinc-500 transition hover:bg-[#2b2b2b] hover:text-zinc-200 disabled:cursor-not-allowed disabled:opacity-40"
                  type="button"
                  :disabled="!selectedVoiceTake(row)"
                  :title="isVoiceTakePreviewPlaying(selectedVoiceTake(row)) ? 'Stop voice take preview' : 'Play voice take preview'"
                  :aria-label="isVoiceTakePreviewPlaying(selectedVoiceTake(row)) ? 'Stop voice take preview' : 'Play voice take preview'"
                  @click.prevent="playVoiceTakePreview(selectedVoiceTake(row))"
                >
                  <Square v-if="isVoiceTakePreviewPlaying(selectedVoiceTake(row))" class="size-3" />
                  <Play v-else class="size-3" />
                </button>
              </span>
              <select
                class="h-9 min-w-0 rounded-md border border-[#38383d] bg-[#181818] px-2 text-sm text-zinc-100 outline-none focus:ring-1 focus:ring-inset focus:ring-emerald-700/70 disabled:cursor-not-allowed disabled:text-zinc-500"
                :value="row.voiceTakeId || ''"
                :disabled="!takesForRow(row).length"
                @change="updateRow(row, { voiceTakeId: ($event.target as HTMLSelectElement).value || null })"
              >
                <option v-for="take in takesForRow(row)" :key="take.id" :value="take.id">
                  {{ take.label }}
                </option>
              </select>
            </label>

            <label class="grid gap-1 text-xs text-zinc-500">
              Model
              <select
                class="h-9 min-w-0 rounded-md border border-[#38383d] bg-[#181818] px-2 text-sm text-zinc-100 outline-none focus:ring-1 focus:ring-inset focus:ring-emerald-700/70"
                :value="row.model"
                @change="updateRow(row, { model: ($event.target as HTMLSelectElement).value as DialogueModel })"
              >
                <option v-for="model in models" :key="model.value" :value="model.value">
                  {{ model.label }}
                </option>
              </select>
            </label>

            <label class="grid gap-1 text-xs text-zinc-500">
              Language
              <select
                class="h-9 min-w-0 rounded-md border border-[#38383d] bg-[#181818] px-2 text-sm text-zinc-100 outline-none focus:ring-1 focus:ring-inset focus:ring-emerald-700/70"
                :value="row.language"
                @change="updateRow(row, { language: ($event.target as HTMLSelectElement).value as LanguageCode })"
              >
                <option v-for="language in languages" :key="language" :value="language">
                  {{ language }}
                </option>
              </select>
            </label>

            <label class="grid gap-1 text-xs text-zinc-500">
              <span class="flex items-center gap-1.5">
                <span>Phrase</span>
                <button
                  class="grid size-4 place-items-center rounded p-0 text-zinc-500 transition hover:bg-[#2b2b2b] hover:text-zinc-200 disabled:cursor-not-allowed disabled:opacity-40"
                  type="button"
                  :disabled="!selectedPhrase(row)"
                  :title="isPhrasePreviewPlaying(row) ? 'Stop phrase preview' : 'Play phrase preview'"
                  :aria-label="isPhrasePreviewPlaying(row) ? 'Stop phrase preview' : 'Play phrase preview'"
                  @click.prevent="playPhrasePreview(row)"
                >
                  <Square v-if="isPhrasePreviewPlaying(row)" class="size-3" />
                  <Play v-else class="size-3" />
                </button>
                <button
                  class="grid size-4 place-items-center rounded p-0 text-zinc-500 transition hover:bg-[#2b2b2b] hover:text-emerald-300 disabled:cursor-not-allowed disabled:opacity-40"
                  type="button"
                  title="Insert selected phrase as active dialogue take"
                  aria-label="Insert selected phrase as active dialogue take"
                  :disabled="saving || !selectedPhrase(row)"
                  @click.prevent="insertSelectedPhrase(row)"
                >
                  <ListPlus class="size-3" />
                </button>
              </span>
              <select
                class="h-9 min-w-0 rounded-md border border-[#38383d] bg-[#181818] px-2 text-sm text-zinc-100 outline-none focus:ring-1 focus:ring-inset focus:ring-emerald-700/70 disabled:cursor-not-allowed disabled:text-zinc-500"
                :value="selectedPhrase(row)?.id || ''"
                :disabled="!phrasesForRow(row).length"
                @change="selectedPhraseIds[row.id] = ($event.target as HTMLSelectElement).value"
              >
                <option v-if="!phrasesForRow(row).length" value="">No phrases</option>
                <option v-for="phrase in phrasesForRow(row)" :key="phrase.id" :value="phrase.id">
                  {{ phrase.label }}
                </option>
              </select>
            </label>

            <div class="flex items-center justify-end gap-1">
              <button
                class="grid size-9 shrink-0 place-items-center rounded-md border border-[#38383d] text-zinc-300 hover:bg-[#2b2b2b] disabled:cursor-not-allowed disabled:text-zinc-500"
                type="button"
                title="Edit source audio"
                aria-label="Edit source audio"
                :disabled="saving"
                @click="openSourceAudioEditor(row)"
              >
                <AudioLines class="size-4" />
              </button>
              <button
                class="inline-flex h-9 w-9 shrink-0 items-center justify-center gap-2 rounded-md border border-[#38383d] px-0 text-sm text-zinc-300 hover:bg-[#2b2b2b] disabled:cursor-not-allowed disabled:text-zinc-500 2xl:w-auto 2xl:px-3"
                type="button"
                :title="row.sourceAudio ? `Loaded: ${row.sourceAudio.label}` : 'Load source audio for voice conversion'"
                :disabled="saving"
                @click="openSourceAudioPicker(row)"
              >
                <Upload class="size-4" />
                <span class="hidden 2xl:inline">Load</span>
              </button>
              <button
                class="inline-flex h-9 w-9 shrink-0 items-center justify-center gap-2 rounded-md border border-[#38383d] px-0 text-sm text-zinc-300 hover:bg-[#2b2b2b] disabled:cursor-not-allowed disabled:text-zinc-500 2xl:w-28 2xl:px-3"
                type="button"
                :title="convertingRowId === row.id ? generationStatus[row.id] || 'Converting voice' : 'Convert loaded source audio to the selected voice'"
                :disabled="saving || Boolean(generatingRowId) || Boolean(convertingRowId) || Boolean(convertingTakeId) || row.model !== 'cosyvoice3' || !row.sourceAudio || !row.voiceProfileId || !row.voiceTakeId"
                @click="convertDialogueTake(row)"
              >
                <Loader v-if="convertingRowId === row.id" class="size-4 animate-spin" />
                <ArrowLeftRight v-else class="size-4" />
                <span v-if="convertingRowId !== row.id" class="hidden 2xl:inline">Convert</span>
              </button>
              <button
                class="inline-flex h-9 w-9 shrink-0 items-center justify-center gap-2 rounded-md bg-emerald-600 px-0 text-sm font-medium text-white hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-50 2xl:w-28 2xl:px-3"
                type="button"
                :title="generatingRowId === row.id ? generationStatus[row.id] || 'Generating dialogue audio' : 'Generate dialogue take (Ctrl + G)'"
                :disabled="saving || Boolean(generatingRowId) || Boolean(convertingRowId) || Boolean(convertingTakeId) || !dialogueTextValue(row).trim() || !row.voiceProfileId || !row.voiceTakeId"
                @click="generateDialogueTake(row)"
              >
                <Loader v-if="generatingRowId === row.id" class="size-4 animate-spin" />
                <WandSparkles v-else class="size-4" />
                <span v-if="generatingRowId !== row.id" class="hidden 2xl:inline">Generate</span>
              </button>
              <button
                class="grid size-7 place-items-center rounded-md text-zinc-300 hover:bg-[#2b2b2b]"
                :class="isDuplicateAppendMode(row) ? 'bg-indigo-600 text-white hover:bg-indigo-500' : ''"
                type="button"
                title="Duplicate row. Shift-click to copy to the end."
                aria-label="Duplicate row"
                @mouseenter="setDuplicateAppendHover(row, true)"
                @mouseleave="setDuplicateAppendHover(row, false)"
                @click="duplicateRow(row, $event)"
              >
                <CopyPlus class="size-3.5" />
              </button>
              <button
                class="grid size-7 place-items-center rounded-md text-red-300 hover:bg-red-500/10"
                type="button"
                title="Delete row"
                @click="requestDeleteRow(row)"
              >
                <Trash2 class="size-3.5" />
              </button>
            </div>
          </div>

          <p
            v-if="generationErrors[row.id]"
            class="rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-200"
          >
            {{ generationErrors[row.id] }}
          </p>

          <div class="grid grid-cols-[minmax(0,3fr)_minmax(0,2fr)] items-stretch gap-3">
            <div class="grid h-full grid-rows-[auto_minmax(0,1fr)] gap-1">
              <div class="flex min-h-6 flex-wrap items-center gap-1.5 text-xs text-zinc-500">
                <label class="mr-1" :for="`dialogue-text-${row.id}`">Dialogue text</label>
                <button
                  v-for="token in dialogueTextTokens"
                  :key="token"
                  class="rounded border border-[#38383d] bg-[#202020] px-1.5 py-0.5 font-mono text-[10px] leading-4 text-zinc-300 transition hover:border-emerald-700/70 hover:text-emerald-200 disabled:cursor-not-allowed disabled:border-[#2b2b2b] disabled:bg-[#181818] disabled:text-zinc-600"
                  type="button"
                  :disabled="activeDialogueTextRowId !== row.id"
                  :title="activeDialogueTextRowId === row.id ? `Insert ${token}` : 'Focus the dialogue text field to insert tokens'"
                  @mousedown.prevent
                  @click="insertDialogueTextToken(row, token)"
                >
                  {{ token }}
                </button>
                <div class="relative" data-pinyin-picker>
                  <button
                    class="rounded border border-[#38383d] bg-[#202020] px-1.5 py-0.5 text-[10px] font-medium leading-4 text-zinc-300 transition hover:border-emerald-700/70 hover:text-emerald-200 disabled:cursor-not-allowed disabled:border-[#2b2b2b] disabled:bg-[#181818] disabled:text-zinc-600"
                    :class="pinyinPanelRowId === row.id ? 'border-emerald-700/70 bg-emerald-500/10 text-emerald-200' : ''"
                    type="button"
                    :disabled="activeDialogueTextRowId !== row.id"
                    :title="activeDialogueTextRowId === row.id ? 'Insert pinyin tone vowels' : 'Focus the dialogue text field to insert pinyin'"
                    :aria-expanded="pinyinPanelRowId === row.id"
                    @mousedown.prevent
                    @click="togglePinyinPanel(row)"
                  >
                    Pinyin
                  </button>
                  <div
                    v-if="pinyinPanelRowId === row.id"
                    class="absolute left-0 top-full z-30 mt-1 grid w-56 grid-cols-8 overflow-hidden rounded border border-emerald-700/60 bg-[#151515] p-0 shadow-xl shadow-black/50"
                  >
                    <template v-for="(pinyinRow, rowIndex) in pinyinToneRows" :key="rowIndex">
                      <button
                        v-for="character in pinyinRow"
                        :key="character"
                        class="grid h-5 w-full place-items-center border-b border-r border-[#2b2b2b] p-0 font-mono text-[11px] leading-none text-zinc-200 outline-none transition hover:bg-emerald-500/15 hover:text-emerald-200 focus:bg-emerald-500/15 focus:text-emerald-200"
                        type="button"
                        :title="`Insert ${character}`"
                        @mousedown.prevent
                        @click="insertPinyinTone(row, character)"
                      >
                        {{ character }}
                      </button>
                    </template>
                  </div>
                </div>
                <button
                  class="rounded border border-[#38383d] bg-[#202020] px-1.5 py-0.5 text-[10px] font-medium leading-4 text-zinc-300 transition hover:border-emerald-700/70 hover:text-emerald-200 disabled:cursor-not-allowed disabled:border-[#2b2b2b] disabled:bg-[#181818] disabled:text-zinc-600"
                  type="button"
                  :disabled="saving || !activeDialogueTake(row) || !dialogueTextValue(row).trim()"
                  title="Update the current active take's saved generation text from this dialogue text."
                  @click="updateActiveTakeText(row)"
                >
                  Update Text
                </button>
              </div>
              <textarea
                :id="`dialogue-text-${row.id}`"
                :ref="(element) => registerDialogueTextEditor(row, element)"
                class="h-full min-h-20 resize-y rounded-md border border-[#38383d] bg-[#181818] px-2.5 py-1.5 text-sm leading-6 text-zinc-100 outline-none focus:ring-1 focus:ring-inset focus:ring-emerald-700/70"
                :value="dialogueTextValue(row)"
                @focus="rememberDialogueTextEditor(row, $event)"
                @input="dialogueTextDrafts[row.id] = ($event.target as HTMLTextAreaElement).value"
                @keydown.escape.prevent="cancelDialogueTextDraft(row, $event)"
                @blur="saveDialogueTextDraft(row, $event)"
              />
            </div>

            <div class="grid h-full grid-rows-[auto_minmax(0,1fr)] gap-1">
              <div class="flex min-h-6 flex-wrap items-center justify-between gap-2 text-xs text-zinc-500">
                <label class="font-medium uppercase tracking-wide" :for="`cosy-instruct-${row.id}`">CosyVoice3</label>
                <div class="flex flex-wrap items-center gap-1">
                  <button
                    v-for="(preset, presetIndex) in props.instructPresets"
                    :key="presetIndex"
                    class="rounded border border-[#38383d] bg-[#202020] px-0.5 py-0 font-mono text-[10px] leading-4 text-zinc-300 transition hover:border-emerald-700/70 hover:text-emerald-200 disabled:cursor-not-allowed disabled:border-[#2b2b2b] disabled:bg-[#181818] disabled:text-zinc-600"
                    type="button"
                    :disabled="row.model !== 'cosyvoice3' || row.cosyvoice.useRefText || !preset.trim()"
                    :title="preset.trim() || `Instruct preset ${presetIndex + 1} is empty`"
                    @click="applyCosyInstructPreset(row, preset)"
                  >
                    {{ presetIndex + 1 }}
                  </button>
                </div>
                <span
                  class="font-mono text-[11px] leading-none"
                  :class="cosyInstructCharacterCount(row) > 100 ? 'text-red-400' : 'text-zinc-500'"
                >
                  {{ cosyInstructCharacterCount(row) }}/100
                </span>
                <label
                  class="flex items-center gap-2 text-xs text-zinc-400"
                  title="Zero-shot: ref_audio + ref_text - Clone voice with semantic alignment - source/target in same language"
                >
                  <input
                    class="size-4 accent-emerald-500"
                    type="checkbox"
                    :checked="row.cosyvoice.useRefText"
                    :disabled="row.model !== 'cosyvoice3'"
                    @change="updateRow(row, { cosyvoice: { ...row.cosyvoice, useRefText: ($event.target as HTMLInputElement).checked } })"
                  />
                  Zero-shot
                </label>
              </div>
              <textarea
                :id="`cosy-instruct-${row.id}`"
                :ref="(element) => registerCosyInstructEditor(row, element)"
                class="h-full min-h-20 resize-y rounded-md border border-[#38383d] bg-[#181818] px-2.5 py-1.5 text-sm leading-6 text-zinc-200 outline-none focus:ring-1 focus:ring-inset focus:ring-emerald-700/70 disabled:cursor-not-allowed disabled:opacity-50"
                :disabled="row.model !== 'cosyvoice3' || row.cosyvoice.useRefText"
                :value="cosyInstructValue(row)"
                placeholder="Instruct text"
                @focus="rememberCosyInstructEditor"
                @input="cosyInstructDrafts[row.id] = ($event.target as HTMLTextAreaElement).value"
                @keydown.escape.prevent="cancelCosyInstructDraft(row, $event)"
                @blur="saveCosyInstructDraft(row, $event)"
              />
            </div>
          </div>

          <div class="rounded-md border border-[#2b2b2b] bg-[#181818] p-3">
            <div class="mb-2 flex items-center justify-between">
              <button
                class="inline-flex h-8 items-center gap-2 rounded-md px-2 text-xs font-medium uppercase tracking-wide text-zinc-500 hover:bg-[#2b2b2b] hover:text-zinc-300"
                type="button"
                :title="isTakeAreaExpanded(row) ? 'Collapse dialogue takes (T)' : 'Expand dialogue takes (T)'"
                @click="toggleTakeArea(row)"
              >
                <ChevronUp v-if="isTakeAreaExpanded(row)" class="size-4" />
                <ChevronDown v-else class="size-4" />
                Dialogue takes
              </button>
              <div class="flex items-center gap-2">
                <button
                  class="inline-flex h-8 items-center justify-center gap-2 rounded-md border border-[#38383d] px-3 text-xs font-semibold text-zinc-300 hover:bg-[#2b2b2b] disabled:cursor-not-allowed disabled:text-zinc-500"
                  type="button"
                  :disabled="!activeDialogueTake(row) || row.audioTakes.length < 2"
                  title="Edit regions across multiple dialogue takes"
                  @click="openMultiTakesEditor(row)"
                >
                  <ChartNoAxesGantt class="size-3.5" />
                  Multi-Takes Edit
                </button>
                <button
                  class="inline-flex h-8 w-28 items-center justify-center gap-2 rounded-md border border-[#38383d] px-2 text-xs text-zinc-300 hover:bg-[#2b2b2b] disabled:cursor-not-allowed disabled:text-zinc-500"
                  type="button"
                  :disabled="!activeDialogueTake(row)"
                  @click="playActiveTake(row)"
                >
                  <Pause v-if="isPlayingActiveTake(row)" class="size-3.5" />
                  <Play v-else class="size-3.5" />
                  {{ isPlayingActiveTake(row) ? "Stop active" : "Play active" }}
                </button>
              </div>
            </div>

            <div v-if="row.audioTakes.length && !isTakeAreaExpanded(row)" class="relative rounded-md border border-[#2b2b2b] bg-[#202020] p-2">
              <span
                v-if="activeDialogueTake(row) && isZeroShotDialogueTake(activeDialogueTake(row)!)"
                class="pointer-events-none absolute left-0 top-0 z-10 rounded-sm border border-emerald-700/70 bg-[#181818]/90 px-1 text-[9px] font-semibold leading-[10px] text-emerald-700/70"
                title="Zero-shot generated with ref_text"
              >
                ZS
              </span>
              <div
                v-if="activeDialogueTake(row)"
                class="grid items-center gap-1"
                style="grid-template-columns: minmax(9.75rem, clamp(12rem, 18vw, 15rem)) auto auto minmax(12rem, 1fr) auto clamp(10.2rem, 12vw, 11.4rem) auto auto auto;"
              >
                <div class="relative min-w-0">
                  <select
                    class="h-9 w-full appearance-none rounded-md border border-[#38383d] bg-[#181818] pl-3 pr-8 text-sm text-zinc-100 outline-none focus:ring-1 focus:ring-inset focus:ring-emerald-700/70"
                    :value="row.activeTakeId || ''"
                    @change="setActiveTakeFromSelect(row, $event)"
                  >
                    <option v-for="take in row.audioTakes" :key="take.id" :value="take.id">
                      {{ take.label }}
                    </option>
                  </select>
                  <ChevronDown class="pointer-events-none absolute right-2 top-2.5 size-4 text-zinc-500" />
                </div>
                <button
                  class="grid size-8 shrink-0 place-items-center rounded-md border border-[#38383d] text-zinc-300 hover:bg-[#2b2b2b] disabled:cursor-not-allowed disabled:text-zinc-500"
                  type="button"
                  :title="convertingTakeId === activeDialogueTake(row)!.id ? generationStatus[row.id] || 'Converting take' : 'Convert active take to the selected voice'"
                  aria-label="Convert active take"
                  :disabled="saving || Boolean(generatingRowId) || Boolean(convertingRowId) || Boolean(convertingTakeId) || row.model !== 'cosyvoice3' || !row.voiceProfileId || !row.voiceTakeId || isMissingAudio(activeDialogueTake(row)!)"
                  @click="convertDialogueTake(row, activeDialogueTake(row)!)"
                >
                  <Loader v-if="convertingTakeId === activeDialogueTake(row)!.id" class="size-4 animate-spin" />
                  <ArrowLeftRight v-else class="size-4" />
                </button>
                <button
                  class="grid size-8 shrink-0 place-items-center rounded-md border border-[#38383d] text-zinc-300 hover:bg-[#2b2b2b]"
                  type="button"
                  title="Edit audio"
                  aria-label="Edit active take audio"
                  @click="openAudioEditor(row, activeDialogueTake(row)!)"
                >
                  <AudioLines class="size-4" />
                </button>
                <SimpleWaveform
                  class="min-w-0"
                  :src="dialogueTakeAudioUrl(activeDialogueTake(row)!)"
                  :current-time="playbackStateForTake(activeDialogueTake(row)!).currentTime"
                  :duration="playbackStateForTake(activeDialogueTake(row)!).duration"
                  :disabled="isMissingAudio(activeDialogueTake(row)!)"
                  @seek="seekAndActivateDialogueTake(row, activeDialogueTake(row)!, $event)"
                />
                <div class="relative">
                  <button
                    class="inline-flex h-7 w-12 items-center justify-center gap-px rounded border border-[#38383d] bg-[#151515] px-0.5 text-[10px] font-medium leading-none text-zinc-300 outline-none hover:border-emerald-700/70 hover:bg-emerald-500/10 focus:border-emerald-700/70 focus:ring-1 focus:ring-inset focus:ring-emerald-700/70 disabled:cursor-not-allowed disabled:text-zinc-600"
                    type="button"
                    :disabled="isMissingAudio(activeDialogueTake(row)!) || isDownloadingTake(activeDialogueTake(row)!)"
                    title="Playback speed"
                    aria-label="Playback speed"
                    :aria-expanded="isPlaybackRateMenuOpen(activeDialogueTake(row)!)"
                    @click="togglePlaybackRateMenu(activeDialogueTake(row)!)"
                  >
                    <span>{{ formatPlaybackRate(playbackRateForTake(activeDialogueTake(row)!)) }}x</span>
                    <ChevronDown class="size-2 text-zinc-500" />
                  </button>
                  <div
                    v-if="isPlaybackRateMenuOpen(activeDialogueTake(row)!)"
                    class="absolute bottom-full left-0 z-20 mb-1 w-12 overflow-hidden rounded border border-[#38383d] bg-[#151515] shadow-xl shadow-black/40"
                  >
                    <button
                      v-for="rate in playbackSpeedRates"
                      :key="rate"
                      class="block h-5 w-full px-0.5 text-left text-[10px] font-medium leading-none text-zinc-300 hover:bg-emerald-500/15 hover:text-emerald-300"
                      type="button"
                      @click="setPlaybackRate(activeDialogueTake(row)!, rate)"
                    >
                      {{ formatPlaybackRate(rate) }}x
                    </button>
                  </div>
                </div>
                <AudioPlaybackControls
                  class="min-w-0"
                  :src="dialogueTakeAudioUrl(activeDialogueTake(row)!)"
                  :playback-rate="playbackRateForTake(activeDialogueTake(row)!)"
                  :show-volume="false"
                  :disabled="isMissingAudio(activeDialogueTake(row)!)"
                  @audio-ref="registerTakeAudio(activeDialogueTake(row)!, $event)"
                  @loadedmetadata="updateTakePlaybackState(activeDialogueTake(row)!, $event)"
                  @durationchange="updateTakePlaybackState(activeDialogueTake(row)!, $event)"
                  @timeupdate="updateTakePlaybackState(activeDialogueTake(row)!, $event)"
                  @seeked="updateTakePlaybackState(activeDialogueTake(row)!, $event)"
                  @play="startTakePlaybackAnimation(activeDialogueTake(row)!, $event)"
                  @playing="startTakePlaybackAnimation(activeDialogueTake(row)!, $event)"
                  @pause="stopTakePlaybackAnimation(activeDialogueTake(row)!); markTakeStopped(activeDialogueTake(row)!)"
                  @ended="stopTakePlaybackAnimation(activeDialogueTake(row)!); markTakeStopped(activeDialogueTake(row)!)"
                  @error="reportMissingAudio(activeDialogueTake(row)!)"
                />
                <button
                  class="grid size-7 shrink-0 place-items-center rounded-md text-zinc-300 hover:bg-[#2b2b2b] disabled:cursor-not-allowed disabled:text-zinc-500"
                  :class="isSpeedReplaceMode(activeDialogueTake(row)!) ? 'bg-indigo-600 text-white hover:bg-indigo-500 disabled:text-indigo-200' : ''"
                  type="button"
                  :title="isSpeedReplaceMode(activeDialogueTake(row)!) ? 'Render selected speed and replace active take audio' : 'Download active take audio with selected playback speed'"
                  :aria-label="isSpeedReplaceMode(activeDialogueTake(row)!) ? 'Render selected speed and replace active take audio' : 'Download active take audio with selected playback speed'"
                  :disabled="saving || isMissingAudio(activeDialogueTake(row)!) || isDownloadingTake(activeDialogueTake(row)!)"
                  @mouseenter="setSpeedReplaceHover(activeDialogueTake(row)!, true)"
                  @mouseleave="setSpeedReplaceHover(activeDialogueTake(row)!, false)"
                  @click="clickDialogueTakeDownload(row, activeDialogueTake(row)!)"
                >
                  <Loader v-if="isDownloadingTake(activeDialogueTake(row)!)" class="size-3.5 animate-spin" />
                  <ArrowDownUp v-else-if="isSpeedReplaceMode(activeDialogueTake(row)!)" class="size-3.5" />
                  <Download v-else class="size-3.5" />
                </button>
                <button
                  class="grid size-7 shrink-0 place-items-center rounded-md text-zinc-300 hover:bg-[#2b2b2b] disabled:cursor-not-allowed disabled:text-zinc-500"
                  :class="isPhraseInsertMode(activeDialogueTake(row)!) ? 'bg-indigo-600 text-white hover:bg-indigo-500 disabled:text-indigo-200' : ''"
                  type="button"
                  :title="isPhraseInsertMode(activeDialogueTake(row)!) ? 'Save active take as a phrase on the selected voice profile' : 'Upload WAV to replace active take audio. Shift-click to save this take as a phrase.'"
                  :aria-label="isPhraseInsertMode(activeDialogueTake(row)!) ? 'Save active take as phrase' : 'Upload WAV to replace active take audio'"
                  :disabled="saving || isMissingAudio(activeDialogueTake(row)!) || (isPhraseInsertMode(activeDialogueTake(row)!) && (!row.voiceProfileId || !dialogueTextValue(row).trim()))"
                  @mouseenter="setPhraseInsertHover(activeDialogueTake(row)!, true)"
                  @mouseleave="setPhraseInsertHover(activeDialogueTake(row)!, false)"
                  @click="clickDialogueTakeUpload(row, activeDialogueTake(row)!, $event)"
                >
                  <span v-if="isPhraseInsertMode(activeDialogueTake(row)!)" class="relative grid size-4 place-items-center">
                    <Database class="size-3.5" />
                    <Plus class="absolute -right-1 -top-1 size-2.5 stroke-[3]" />
                  </span>
                  <Upload v-else class="size-3.5" />
                </button>
                <button
                  class="grid size-7 shrink-0 place-items-center rounded-md text-red-300 hover:bg-red-500/10"
                  type="button"
                  title="Delete active take"
                  @click="requestDeleteActiveTake(row)"
                >
                  <Trash2 class="size-3.5" />
                </button>
              </div>
              <div
                v-if="activeDialogueTake(row) && isMissingAudio(activeDialogueTake(row)!)"
                class="mt-2 flex items-center justify-between gap-3 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-100"
              >
                <span class="min-w-0">Active take audio is missing from disk.</span>
                <button
                  class="shrink-0 rounded-md border border-amber-500/30 px-2 py-1 text-amber-100 hover:bg-amber-500/10"
                  type="button"
                  @click="requestDeleteActiveTake(row)"
                >
                  Delete stale take
                </button>
              </div>
            </div>

            <div v-else-if="row.audioTakes.length" class="grid gap-2">
              <div
                v-for="take in row.audioTakes"
                :key="take.id"
                class="relative grid items-center gap-0.5 rounded-md border border-[#2b2b2b] bg-[#202020] px-1.5 py-1 transition"
                :class="[
                  isMissingAudio(take) ? 'border-amber-500/30 bg-amber-500/10' : '',
                  draggedTakeId === take.id ? 'opacity-50' : '',
                  dragOverTakeId === take.id && draggedTakeId !== take.id ? 'border-emerald-700/70 bg-emerald-500/5' : '',
                ]"
                style="grid-template-columns: 14px auto minmax(7.75rem, clamp(9rem, 14vw, 11rem)) auto auto minmax(12rem, 1fr) auto clamp(10.2rem, 12vw, 11.4rem) auto auto auto;"
                @dragover="dragOverTake(take, $event)"
                @drop.prevent="dropTake(row, take)"
              >
                <span
                  v-if="isZeroShotDialogueTake(take)"
                  class="pointer-events-none absolute left-0 top-0 z-10 rounded-sm border border-emerald-700/70 bg-[#181818]/90 px-0.5 text-[8px] font-semibold leading-[11px] text-emerald-600/80"
                  title="Zero-shot generated with ref_text"
                >
                  ZS
                </span>
                <button
                  class="grid h-full min-h-8 w-3.5 shrink-0 cursor-grab place-items-center rounded-sm text-zinc-500 hover:bg-[#2b2b2b] hover:text-zinc-200 active:cursor-grabbing disabled:cursor-not-allowed disabled:text-zinc-700"
                  type="button"
                  draggable="true"
                  title="Drag to reorder"
                  aria-label="Drag to reorder take"
                  :disabled="saving || row.audioTakes.length < 2"
                  @dragstart="startTakeDrag(take, $event)"
                  @dragend="finishTakeDrag"
                >
                  <GripVertical class="h-5 w-3" />
                </button>
                <button
                  class="grid size-8 shrink-0 place-items-center rounded-md border border-[#38383d] text-zinc-400 hover:bg-[#2b2b2b] hover:text-zinc-100"
                  :class="row.activeTakeId === take.id ? 'border-emerald-700/70 bg-emerald-500/10 text-emerald-400' : ''"
                  type="button"
                  :aria-label="row.activeTakeId === take.id ? 'Active take' : 'Set active take'"
                  @click="setActiveTake(row, take)"
                >
                  <Check class="size-4" />
                </button>
                <input
                  class="h-9 min-w-0 flex-1 rounded-md border border-transparent bg-transparent px-2 text-sm text-zinc-100 outline-none hover:border-[#38383d] focus:ring-1 focus:ring-inset focus:ring-emerald-700/70"
                  :data-dialogue-take-label-id="take.id"
                  :value="takeLabelDrafts[take.id] ?? take.label"
                  @blur="updateTakeLabel(take, $event)"
                  @input="takeLabelDrafts[take.id] = ($event.target as HTMLInputElement).value"
                  @keydown.enter.prevent="confirmInlineEdit"
                  @keydown.escape.prevent="cancelTakeLabelEdit(take, $event)"
                />
                <button
                  class="grid size-8 shrink-0 place-items-center rounded-md border border-[#38383d] text-zinc-300 hover:bg-[#2b2b2b] disabled:cursor-not-allowed disabled:text-zinc-500"
                  type="button"
                  :title="convertingTakeId === take.id ? generationStatus[row.id] || 'Converting take' : 'Convert this take to the selected voice'"
                  aria-label="Convert take"
                  :disabled="saving || Boolean(generatingRowId) || Boolean(convertingRowId) || Boolean(convertingTakeId) || row.model !== 'cosyvoice3' || !row.voiceProfileId || !row.voiceTakeId || isMissingAudio(take)"
                  @click="convertDialogueTake(row, take)"
                >
                  <Loader v-if="convertingTakeId === take.id" class="size-4 animate-spin" />
                  <ArrowLeftRight v-else class="size-4" />
                </button>
                <button
                  class="grid size-8 shrink-0 place-items-center rounded-md border border-[#38383d] text-zinc-300 hover:bg-[#2b2b2b] disabled:cursor-not-allowed disabled:text-zinc-500"
                  type="button"
                  title="Edit audio"
                  aria-label="Edit take audio"
                  :disabled="isMissingAudio(take)"
                  @click="openAudioEditor(row, take)"
                >
                  <AudioLines class="size-4" />
                </button>
                <SimpleWaveform
                  class="min-w-0"
                  :src="dialogueTakeAudioUrl(take)"
                  :current-time="playbackStateForTake(take).currentTime"
                  :duration="playbackStateForTake(take).duration"
                  :disabled="isMissingAudio(take)"
                  @seek="seekAndActivateDialogueTake(row, take, $event)"
                />
                <div class="relative">
                  <button
                    class="inline-flex h-7 w-12 items-center justify-center gap-px rounded border border-[#38383d] bg-[#151515] px-0.5 text-[10px] font-medium leading-none text-zinc-300 outline-none hover:border-emerald-700/70 hover:bg-emerald-500/10 focus:border-emerald-700/70 focus:ring-1 focus:ring-inset focus:ring-emerald-700/70 disabled:cursor-not-allowed disabled:text-zinc-600"
                    type="button"
                    :disabled="isMissingAudio(take) || isDownloadingTake(take)"
                    title="Playback speed"
                    aria-label="Playback speed"
                    :aria-expanded="isPlaybackRateMenuOpen(take)"
                    @click="togglePlaybackRateMenu(take)"
                  >
                    <span>{{ formatPlaybackRate(playbackRateForTake(take)) }}x</span>
                    <ChevronDown class="size-2 text-zinc-500" />
                  </button>
                  <div
                    v-if="isPlaybackRateMenuOpen(take)"
                    class="absolute bottom-full left-0 z-20 mb-1 w-12 overflow-hidden rounded border border-[#38383d] bg-[#151515] shadow-xl shadow-black/40"
                  >
                    <button
                      v-for="rate in playbackSpeedRates"
                      :key="rate"
                      class="block h-5 w-full px-0.5 text-left text-[10px] font-medium leading-none text-zinc-300 hover:bg-emerald-500/15 hover:text-emerald-300"
                      type="button"
                      @click="setPlaybackRate(take, rate)"
                    >
                      {{ formatPlaybackRate(rate) }}x
                    </button>
                  </div>
                </div>
                <AudioPlaybackControls
                  class="min-w-0"
                  :src="dialogueTakeAudioUrl(take)"
                  :playback-rate="playbackRateForTake(take)"
                  :show-volume="false"
                  :disabled="isMissingAudio(take)"
                  @audio-ref="registerTakeAudio(take, $event)"
                  @loadedmetadata="updateTakePlaybackState(take, $event)"
                  @durationchange="updateTakePlaybackState(take, $event)"
                  @timeupdate="updateTakePlaybackState(take, $event)"
                  @seeked="updateTakePlaybackState(take, $event)"
                  @play="startTakePlaybackAnimation(take, $event)"
                  @playing="startTakePlaybackAnimation(take, $event)"
                  @pause="stopTakePlaybackAnimation(take); markTakeStopped(take)"
                  @ended="stopTakePlaybackAnimation(take); markTakeStopped(take)"
                  @error="reportMissingAudio(take)"
                />
                <button
                  class="grid size-7 shrink-0 place-items-center rounded-md text-zinc-300 hover:bg-[#2b2b2b] disabled:cursor-not-allowed disabled:text-zinc-500"
                  :class="isSpeedReplaceMode(take) ? 'bg-indigo-600 text-white hover:bg-indigo-500 disabled:text-indigo-200' : ''"
                  type="button"
                  :title="isSpeedReplaceMode(take) ? 'Render selected speed and replace take audio' : 'Download take audio with selected playback speed'"
                  :aria-label="isSpeedReplaceMode(take) ? 'Render selected speed and replace take audio' : 'Download take audio with selected playback speed'"
                  :disabled="saving || isMissingAudio(take) || isDownloadingTake(take)"
                  @mouseenter="setSpeedReplaceHover(take, true)"
                  @mouseleave="setSpeedReplaceHover(take, false)"
                  @click="clickDialogueTakeDownload(row, take)"
                >
                  <Loader v-if="isDownloadingTake(take)" class="size-3.5 animate-spin" />
                  <ArrowDownUp v-else-if="isSpeedReplaceMode(take)" class="size-3.5" />
                  <Download v-else class="size-3.5" />
                </button>
                <button
                  class="grid size-7 shrink-0 place-items-center rounded-md text-zinc-300 hover:bg-[#2b2b2b] disabled:cursor-not-allowed disabled:text-zinc-500"
                  :class="isPhraseInsertMode(take) ? 'bg-indigo-600 text-white hover:bg-indigo-500 disabled:text-indigo-200' : ''"
                  type="button"
                  :title="isPhraseInsertMode(take) ? 'Save take as a phrase on the selected voice profile' : 'Upload WAV to replace take audio. Shift-click to save this take as a phrase.'"
                  :aria-label="isPhraseInsertMode(take) ? 'Save take as phrase' : 'Upload WAV to replace take audio'"
                  :disabled="saving || isMissingAudio(take) || (isPhraseInsertMode(take) && (!row.voiceProfileId || !dialogueTextValue(row).trim()))"
                  @mouseenter="setPhraseInsertHover(take, true)"
                  @mouseleave="setPhraseInsertHover(take, false)"
                  @click="clickDialogueTakeUpload(row, take, $event)"
                >
                  <span v-if="isPhraseInsertMode(take)" class="relative grid size-4 place-items-center">
                    <Database class="size-3.5" />
                    <Plus class="absolute -right-1 -top-1 size-2.5 stroke-[3]" />
                  </span>
                  <Upload v-else class="size-3.5" />
                </button>
                <button
                  class="grid size-7 shrink-0 place-items-center rounded-md text-red-300 hover:bg-red-500/10"
                  type="button"
                  title="Delete take"
                  @click="requestDeleteTake(take)"
                >
                  <Trash2 class="size-3.5" />
                </button>
                <button
                  v-if="isMissingAudio(take)"
                  class="shrink-0 rounded-md border border-amber-500/30 px-2 py-1 text-xs text-amber-100 hover:bg-amber-500/10"
                  type="button"
                  @click="requestDeleteTake(take)"
                >
                  Delete stale
                </button>
              </div>
            </div>

            <p v-else class="py-4 text-center text-sm text-zinc-500">No dialogue takes yet.</p>
          </div>
        </div>
      </article>
    </div>

    <div v-else-if="searchActive" class="border-t border-[#2b2b2b] px-6 py-6 text-sm text-zinc-500">
      No dialogue rows match this search.
    </div>

    <div v-else class="grid min-h-56 place-items-center px-6 text-center">
      <div>
        <Mic2 class="mx-auto mb-3 size-8 text-zinc-600" />
        <p class="text-sm font-medium text-zinc-300">No dialogue rows yet</p>
        <p class="mt-1 text-xs leading-5 text-zinc-500">Add a row after creating at least one voice profile, or start with an empty row.</p>
      </div>
    </div>
  </section>

  <ConfirmDialog
    :open="Boolean(deleteTarget)"
    :title="deleteConfirmation.title"
    :message="deleteConfirmation.message"
    @cancel="deleteTarget = null"
    @confirm="confirmDelete"
  />

  <Teleport to="body">
    <div
      v-if="fullscreenDialogueInfoMedia"
      class="fixed inset-0 z-50 grid place-items-center bg-black/85 p-6"
      role="presentation"
      @click.self="fullscreenDialogueInfoMediaId = null"
    >
      <div class="grid max-h-full max-w-full gap-3">
        <div class="flex items-center justify-between gap-4">
          <p class="truncate text-sm text-zinc-200">{{ fullscreenDialogueInfoMedia.filename }}</p>
          <button
            class="h-9 rounded-md border border-zinc-700 bg-zinc-950/70 px-3 text-sm text-zinc-200 hover:bg-zinc-900"
            type="button"
            @click="fullscreenDialogueInfoMediaId = null"
          >
            Close
          </button>
        </div>
        <img
          v-if="fullscreenDialogueInfoMedia.kind === 'image'"
          class="max-h-[82vh] max-w-[92vw] rounded-md object-contain"
          :src="dialogueInfoMediaUrl(fullscreenDialogueInfoMedia.filePath)"
          :alt="fullscreenDialogueInfoMedia.filename"
        />
        <video
          v-else
          class="max-h-[82vh] max-w-[92vw] rounded-md"
          :src="dialogueInfoMediaUrl(fullscreenDialogueInfoMedia.filePath)"
          controls
          autoplay
        />
      </div>
    </div>
  </Teleport>

  <input
    ref="sourceAudioInput"
    class="hidden"
    type="file"
    accept="audio/*,.wav,.mp3,.flac,.ogg,.m4a"
    @change="uploadSourceAudio"
  />
  <input
    ref="dialogueTakeAudioInput"
    class="hidden"
    type="file"
    accept="audio/wav,audio/wave,audio/x-wav,.wav"
    @change="uploadDialogueTakeAudio"
  />

  <AudioEditorOverlay
    :open="Boolean(audioEditor)"
    :row-label="audioEditor?.rowLabel"
    :source-label="audioEditor?.sourceLabel"
    :audio-src="audioEditor?.audioSrc"
    :take-id="audioEditor?.takeId"
    :take-label="audioEditor?.takeLabel"
    @close="audioEditor = null"
    @save="saveEditedAudio"
    @toast="(...args) => emit('toast', ...args)"
  />

  <MultiTakesEditor
    :open="Boolean(multiTakesEditorRowId)"
    :session="session"
    :row="multiTakesEditorRow()"
    @close="multiTakesEditorRowId = null"
    @rendered="emit('session', $event)"
    @saved="emit('session', $event)"
    @error="emit('error', $event)"
    @toast="(...args) => emit('toast', ...args)"
  />
</template>
