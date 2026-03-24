type FeedState = "NEW" | "SEEN";

type WhatsNewFeedItem = {
  id: string;
  state?: { state?: FeedState | string | null } | null;
  content?: {
    __typename?: string;
    data?: {
      __typename?: string;
      uri?: string;
      name?: string;
      artists?: {
        items?: Array<{
          uri?: string;
          profile?: { name?: string };
        }>;
      };
    };
  };
};

type PlaylistEntry = { name: string; uri: string; isOwnedBySelf?: boolean };
type TrackFingerprint = {
  uri: string;
  name: string;
  durationMs: number | null;
  isExplicit: boolean | null;
};
type TrackNameDurationMap = Map<string, Array<number | null>>;
type TrackSnapshot = {
  uriSet: Set<string>;
  byNameDuration: TrackNameDurationMap;
};

const EXTENSION_NAME = "WhatsNew Auto Save";
const POLL_INTERVAL_MS = 15 * 60 * 1000;
const FEED_PAGE_SIZE = 50;
const MAX_FEED_PAGES_SAFETY = 400;
const MAX_EMPTY_FEED_PAGES = 2;
const DURATION_TOLERANCE_MS = 5000;
const PROCESSED_IDS_KEY = "whatsnew:processed-feed-ids";
const ENABLED_KEY = "whatsnew:enabled";
const VERBOSE_DEBUG_KEY = "whatsnew:verbose-debug";
const VERBOSE_DEBUG_DEFAULT = true;
const SYNC_ICON =
  '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M13 8a5 5 0 0 0-8.66-3.54" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/><path stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" d="M4 2v3h3M3 8a5 5 0 0 0 8.66 3.54"/><path stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" d="M12 14v-3H9"/></svg>';

let menuItem: Spicetify.Menu.Item | null = null;
let timerId: number | null = null;
let isRunning = false;
let topbarButton: Spicetify.Topbar.Button | null = null;

const spotifyGraphQL = Spicetify.GraphQL;
const definitions = spotifyGraphQL.Definitions;

function notify(message: string, isError = false): void {
  Spicetify.showNotification(`${EXTENSION_NAME}: ${message}`, isError, 5000);
}

function debug(message: string, toast = true): void {
  // Always log to console; optional toast for high visibility.
  console.log(`[${EXTENSION_NAME}] ${message}`);
  if (toast && getBoolSetting(VERBOSE_DEBUG_KEY, VERBOSE_DEBUG_DEFAULT)) {
    Spicetify.showNotification(`${EXTENSION_NAME}: ${message}`, false, 2500);
  }
}

function debugResponse(label: string, payload: unknown): void {
  if (!getBoolSetting(VERBOSE_DEBUG_KEY, VERBOSE_DEBUG_DEFAULT)) return;
  console.log(`[${EXTENSION_NAME}] ${label}`, payload);
}

function setMenuItemLabelSafe(item: Spicetify.Menu.Item, label: string): void {
  const maybeSetName = (item as unknown as { setName?: (name: string) => void })
    .setName;
  if (typeof maybeSetName === "function") {
    maybeSetName(label);
    return;
  }

  // Runtime compatibility fallback for clients where setName is missing.
  (item as unknown as { name?: string }).name = label;
}

function getBoolSetting(key: string, fallback = true): boolean {
  const raw = Spicetify.LocalStorage.get(key);
  if (raw === null) return fallback;
  return raw === "true";
}

function setBoolSetting(key: string, value: boolean): void {
  Spicetify.LocalStorage.set(key, value ? "true" : "false");
}

function getJson<T>(key: string, fallback: T): T {
  const raw = Spicetify.LocalStorage.get(key);
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function setJson<T>(key: string, value: T): void {
  Spicetify.LocalStorage.set(key, JSON.stringify(value));
}

function getProcessedIds(): Set<string> {
  return new Set<string>(getJson<string[]>(PROCESSED_IDS_KEY, []));
}

function setProcessedIds(ids: Set<string>): void {
  const trimmed = Array.from(ids).slice(-5000);
  setJson(PROCESSED_IDS_KEY, trimmed);
}

function chunks<T>(input: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let i = 0; i < input.length; i += size) {
    result.push(input.slice(i, i + size));
  }
  return result;
}

function normalizeTrackName(name: string): string {
  let normalized = name.toLowerCase().trim();
  normalized = normalized.replace(/\s*[([].*?[)\]]/g, "");
  normalized = normalized.replace(
    /\s*-\s*(remaster(ed)?(\s*\d{2,4})?|live|mono|stereo|single version|radio edit).*$/i,
    "",
  );
  normalized = normalized.replace(/\s+/g, " ").trim();
  return normalized;
}

function normalizeDuration(
  durationMs: number | undefined | null,
): number | null {
  if (typeof durationMs === "number" && Number.isFinite(durationMs))
    return durationMs;
  return null;
}

function hasDurationMatch(
  map: TrackNameDurationMap,
  normalizedName: string,
  duration: number | null,
): boolean {
  const durations = map.get(normalizedName);
  if (!durations) return false;
  for (const existingDuration of durations) {
    if (existingDuration === null || duration === null) return true;
    if (Math.abs(existingDuration - duration) <= DURATION_TOLERANCE_MS)
      return true;
  }
  return false;
}

function addDurationEntry(
  map: TrackNameDurationMap,
  normalizedName: string,
  duration: number | null,
): void {
  const durations = map.get(normalizedName) ?? [];
  durations.push(duration);
  map.set(normalizedName, durations);
}

function buildSnapshot(tracks: TrackFingerprint[]): TrackSnapshot {
  const uriSet = new Set<string>();
  const byNameDuration: TrackNameDurationMap = new Map();
  for (const track of tracks) {
    uriSet.add(track.uri);
    addDurationEntry(
      byNameDuration,
      normalizeTrackName(track.name),
      track.durationMs,
    );
  }
  return { uriSet, byNameDuration };
}

function areLikelySameTrack(a: TrackFingerprint, b: TrackFingerprint): boolean {
  const sameName = normalizeTrackName(a.name) === normalizeTrackName(b.name);
  if (!sameName) return false;
  if (a.durationMs === null || b.durationMs === null) return true;
  return Math.abs(a.durationMs - b.durationMs) <= DURATION_TOLERANCE_MS;
}

function shouldPreferTrack(
  candidate: TrackFingerprint,
  current: TrackFingerprint,
): boolean {
  if (candidate.isExplicit === true && current.isExplicit !== true) return true;
  if (candidate.isExplicit !== true && current.isExplicit === true)
    return false;
  return false;
}

function dedupeTracksPreferringExplicit(
  tracks: TrackFingerprint[],
): TrackFingerprint[] {
  const result: TrackFingerprint[] = [];
  for (const track of tracks) {
    if (!track.uri || !track.name) continue;
    const matchIndex = result.findIndex((existing) =>
      areLikelySameTrack(existing, track),
    );
    if (matchIndex === -1) {
      result.push(track);
      continue;
    }
    if (shouldPreferTrack(track, result[matchIndex])) {
      result[matchIndex] = track;
    }
  }
  return result;
}

function collectAddableTracks(
  candidates: TrackFingerprint[],
  existing: TrackSnapshot,
): TrackFingerprint[] {
  const dedupedCandidates = dedupeTracksPreferringExplicit(candidates);
  const pendingByNameDuration: TrackNameDurationMap = new Map();
  const result: TrackFingerprint[] = [];

  for (const track of dedupedCandidates) {
    if (!track.uri || !track.name) continue;
    if (existing.uriSet.has(track.uri)) continue;

    const normalizedName = normalizeTrackName(track.name);
    if (
      hasDurationMatch(
        existing.byNameDuration,
        normalizedName,
        track.durationMs,
      )
    )
      continue;
    if (
      hasDurationMatch(pendingByNameDuration, normalizedName, track.durationMs)
    )
      continue;

    addDurationEntry(pendingByNameDuration, normalizedName, track.durationMs);
    result.push(track);
  }

  return result;
}

function addTracksToSnapshot(
  snapshot: TrackSnapshot,
  tracks: TrackFingerprint[],
): void {
  for (const track of tracks) {
    snapshot.uriSet.add(track.uri);
    addDurationEntry(
      snapshot.byNameDuration,
      normalizeTrackName(track.name),
      track.durationMs,
    );
  }
}

async function getAllAlbumTracks(
  albumUri: string,
): Promise<TrackFingerprint[]> {
  debug(`Loading album tracks: ${albumUri}`, false);
  const query = definitions.queryAlbumTracks;
  const tracks: TrackFingerprint[] = [];
  const seenUris = new Set<string>();
  let offset = 0;

  while (true) {
    const response = await spotifyGraphQL.Request(query, {
      uri: albumUri,
      offset,
      limit: 100,
    });
    debugResponse(
      `GraphQL queryAlbumTracks response (album=${albumUri}, offset=${offset})`,
      response,
    );

    const items =
      response?.data?.albumUnion?.tracksV2?.items ??
      response?.data?.albumUnion?.tracks?.items ??
      [];
    if (!items || items.length === 0) break;

    for (const item of items) {
      const track = item?.track ?? item;
      if (typeof track?.uri !== "string" || typeof track?.name !== "string")
        continue;
      if (seenUris.has(track.uri)) continue;
      seenUris.add(track.uri);

      const durationMs = normalizeDuration(
        track?.duration?.totalMilliseconds ??
          track?.durationMs ??
          track?.duration_ms,
      );
      tracks.push({
        uri: track.uri,
        name: track.name,
        durationMs,
        isExplicit:
          typeof track?.isExplicit === "boolean"
            ? track.isExplicit
            : typeof track?.explicit === "boolean"
              ? track.explicit
              : null,
      });
    }

    if (items.length < 100) break;
    offset += 100;
  }

  return tracks;
}

async function likeTracks(trackUris: string[]): Promise<void> {
  debug(`Adding ${trackUris.length} track(s) to Liked Songs`);
  for (const batch of chunks(trackUris, 50)) {
    await Spicetify.Platform.LibraryAPI.add({ uris: batch });
  }
}

function normalizeName(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

function splitPlaylistArtistNames(playlistName: string): string[] {
  return playlistName
    .split("/")
    .map((part) => normalizeName(part))
    .filter((part) => part.length > 0);
}

function collectPlaylists(items: any[], result: PlaylistEntry[]): void {
  for (const item of items) {
    if (!item) continue;
    if (item.type === "playlist" && item.name && item.uri) {
      result.push({
        name: item.name as string,
        uri: item.uri as string,
        isOwnedBySelf:
          typeof item.isOwnedBySelf === "boolean"
            ? item.isOwnedBySelf
            : undefined,
      });
    }

    if (Array.isArray(item.items) && item.items.length > 0) {
      collectPlaylists(item.items, result);
    }
    if (Array.isArray(item.children) && item.children.length > 0) {
      collectPlaylists(item.children, result);
    }
  }
}

async function getAllMyPlaylists(): Promise<PlaylistEntry[]> {
  debug("Reading your playlists from rootlist", false);
  const rootlist = await Spicetify.Platform.RootlistAPI.getContents({
    limit: 50000,
  });
  const playlists: PlaylistEntry[] = [];

  if (Array.isArray(rootlist?.items)) {
    collectPlaylists(rootlist.items, playlists);
  }

  return playlists.filter((playlist) => playlist.isOwnedBySelf !== false);
}

async function getPlaylistTracks(
  playlistUri: string,
): Promise<TrackFingerprint[]> {
  debug(`Reading playlist tracks for duplicate check: ${playlistUri}`, false);
  const contents = await Spicetify.Platform.PlaylistAPI.getContents(
    playlistUri,
    { limit: 9999999 },
  );
  const tracks: TrackFingerprint[] = [];
  const seenUris = new Set<string>();

  for (const item of contents?.items ?? []) {
    const uri = item?.uri;
    const name = item?.name;
    if (typeof uri !== "string" || typeof name !== "string") continue;
    if (seenUris.has(uri)) continue;
    seenUris.add(uri);
    tracks.push({
      uri,
      name,
      durationMs: normalizeDuration(item?.duration_ms),
      isExplicit:
        typeof item?.isExplicit === "boolean"
          ? item.isExplicit
          : typeof item?.explicit === "boolean"
            ? item.explicit
            : null,
    });
  }

  return tracks;
}

function parseContainsResponseToBoolArray(
  response: any,
  expectedLength: number,
): boolean[] {
  if (Array.isArray(response)) return response.map(Boolean);
  if (Array.isArray(response?.contains)) return response.contains.map(Boolean);
  if (Array.isArray(response?.items)) return response.items.map(Boolean);
  return new Array<boolean>(expectedLength).fill(false);
}

async function getUnlikedTrackUris(trackUris: string[]): Promise<string[]> {
  const uniqueUris = Array.from(new Set(trackUris));
  const toAdd: string[] = [];

  for (const batch of chunks(uniqueUris, 50)) {
    try {
      const response = await Spicetify.Platform.LibraryAPI.contains({
        uris: batch,
      });
      const contains = parseContainsResponseToBoolArray(response, batch.length);
      for (let i = 0; i < batch.length; i += 1) {
        if (!contains[i]) toAdd.push(batch[i]);
      }
    } catch {
      // Fallback when contains API is unavailable: let add endpoint dedupe server-side.
      debug(
        "Library contains-check unavailable, falling back to direct add dedupe",
        false,
      );
      toAdd.push(...batch);
    }
  }

  debug(
    `Liked Songs dedupe: ${trackUris.length} candidate(s), ${toAdd.length} new`,
  );
  return toAdd;
}

function extractTrackFingerprintFromLibraryItem(
  item: any,
): TrackFingerprint | null {
  const uri = item?.uri ?? item?.track?.uri ?? item?.item?.uri;
  const name = item?.name ?? item?.track?.name ?? item?.item?.name;
  const durationMs = normalizeDuration(
    item?.duration_ms ??
      item?.durationMs ??
      item?.track?.duration_ms ??
      item?.track?.durationMs ??
      item?.track?.duration?.totalMilliseconds ??
      item?.item?.duration_ms,
  );

  if (typeof uri !== "string" || typeof name !== "string") return null;
  const isExplicit =
    typeof item?.isExplicit === "boolean"
      ? item.isExplicit
      : typeof item?.explicit === "boolean"
        ? item.explicit
        : typeof item?.track?.isExplicit === "boolean"
          ? item.track.isExplicit
          : typeof item?.track?.explicit === "boolean"
            ? item.track.explicit
            : null;
  return { uri, name, durationMs, isExplicit };
}

async function getLikedSongsSnapshot(): Promise<TrackSnapshot | null> {
  const libraryApi = Spicetify.Platform?.LibraryAPI;
  const getTracksMethod = libraryApi?.getTracks;
  if (typeof getTracksMethod !== "function") {
    debug(
      "LibraryAPI.getTracks is unavailable; falling back to URI-only contains check",
      false,
    );
    return null;
  }

  try {
    const collected: TrackFingerprint[] = [];
    const seenUris = new Set<string>();
    let offset = 0;
    const pageSize = 200;

    while (true) {
      const response = await getTracksMethod({ offset, limit: pageSize });
      const items = response?.items ?? response ?? [];
      if (!Array.isArray(items) || items.length === 0) break;

      let pageAdded = 0;
      for (const item of items) {
        const track = extractTrackFingerprintFromLibraryItem(item);
        if (!track || seenUris.has(track.uri)) continue;
        seenUris.add(track.uri);
        collected.push(track);
        pageAdded += 1;
      }

      debug(
        `Liked Songs snapshot page loaded: offset=${offset}, items=${items.length}, added=${pageAdded}`,
        false,
      );
      if (items.length < pageSize) break;
      offset += pageSize;
    }

    debug(
      `Loaded Liked Songs snapshot via LibraryAPI: ${collected.length} track(s)`,
      false,
    );
    return buildSnapshot(collected);
  } catch (error) {
    debug(
      `LibraryAPI.getTracks failed, using URI-only contains fallback: ${String(error)}`,
      false,
    );
    return null;
  }
}

function findMatchingPlaylists(
  playlists: PlaylistEntry[],
  artistNames: string[],
): PlaylistEntry[] {
  const normalizedArtists = new Set(
    artistNames.map((name) => normalizeName(name)),
  );
  return playlists.filter((playlist) => {
    const namesInPlaylist = splitPlaylistArtistNames(playlist.name);
    return namesInPlaylist.some((name) => normalizedArtists.has(name));
  });
}

async function addTracksToPlaylistDeduped(
  playlistUri: string,
  releaseTracks: TrackFingerprint[],
  existingTracksByPlaylist: Map<string, TrackSnapshot>,
): Promise<number> {
  let existingSnapshot = existingTracksByPlaylist.get(playlistUri);
  if (!existingSnapshot) {
    existingSnapshot = buildSnapshot(await getPlaylistTracks(playlistUri));
    existingTracksByPlaylist.set(playlistUri, existingSnapshot);
  }

  const toAddTracks = collectAddableTracks(releaseTracks, existingSnapshot);
  if (toAddTracks.length === 0) {
    debug(`Playlist already up to date: ${playlistUri}`, false);
    return 0;
  }

  const toAdd = toAddTracks.map((track) => track.uri);
  for (const batch of chunks(toAdd, 100)) {
    await Spicetify.Platform.PlaylistAPI.add(playlistUri, batch, {
      after: "end",
    });
  }
  addTracksToSnapshot(existingSnapshot, toAddTracks);

  debug(`Added ${toAdd.length} track(s) to playlist: ${playlistUri}`);
  return toAdd.length;
}

async function queryWhatsNewFeedItems(): Promise<WhatsNewFeedItem[]> {
  const allItems: WhatsNewFeedItem[] = [];
  const seenFeedItemIds = new Set<string>();
  let offset = 0;
  let page = 0;
  let consecutiveEmptyPages = 0;
  const seenOffsets = new Set<number>();

  while (page < MAX_FEED_PAGES_SAFETY) {
    if (seenOffsets.has(offset)) {
      debug(
        `Stopping feed pagination: offset loop detected at ${offset}`,
        false,
      );
      break;
    }
    seenOffsets.add(offset);

    debug(`Querying Whats New page ${page + 1} (offset ${offset})`, false);
    const response = await spotifyGraphQL.Request(
      definitions.queryWhatsNewFeed,
      {
        offset,
        limit: FEED_PAGE_SIZE,
        onlyUnPlayedItems: false,
        includedContentTypes: [],
      },
    );
    debugResponse(
      `GraphQL queryWhatsNewFeed response (page=${page + 1}, offset=${offset})`,
      response,
    );

    const feed = response?.data?.whatsNewFeedItems;
    const items = (feed?.items ?? []) as WhatsNewFeedItem[];
    for (const item of items) {
      if (!item?.id || seenFeedItemIds.has(item.id)) continue;
      seenFeedItemIds.add(item.id);
      allItems.push(item);
    }
    const nextOffset = feed?.pagingInfo?.nextOffset;
    const totalCount = feed?.totalCount;
    const hasExplicitNextOffset =
      typeof nextOffset === "number" && Number.isFinite(nextOffset);
    const computedNextOffset = offset + FEED_PAGE_SIZE;
    const canFallbackBySize = items.length > 0;
    const fallbackNextOffset = canFallbackBySize ? computedNextOffset : null;

    debug(
      `Feed page ${page + 1}: received ${items.length} item(s), accumulated ${allItems.length}${typeof totalCount === "number" ? ` / total ${totalCount}` : ""}, nextOffset=${String(nextOffset)}, fallbackNextOffset=${String(fallbackNextOffset)}`,
      false,
    );

    if (items.length === 0) {
      consecutiveEmptyPages += 1;
      debug(
        `Feed page empty (${consecutiveEmptyPages}/${MAX_EMPTY_FEED_PAGES})`,
        false,
      );
      if (consecutiveEmptyPages >= MAX_EMPTY_FEED_PAGES) {
        debug("Stopping feed pagination: repeated empty pages", false);
        break;
      }
    } else {
      consecutiveEmptyPages = 0;
    }

    // Some clients report totalCount/nextOffset capped (e.g. 150) even when older pages are still queryable.
    // Prefer explicit nextOffset when available, otherwise probe by offset+limit.
    const next = hasExplicitNextOffset ? nextOffset : fallbackNextOffset;
    if (typeof next !== "number" || !Number.isFinite(next) || next <= offset) {
      debug(
        "Stopping feed pagination: no valid next offset provided by API",
        false,
      );
      break;
    }

    offset = next;
    page += 1;
  }

  if (page >= MAX_FEED_PAGES_SAFETY) {
    debug(
      `Stopped feed pagination at safety cap (${MAX_FEED_PAGES_SAFETY} pages)`,
      false,
    );
  }

  return allItems;
}

async function markFeedItemsSeen(feedItemIds: string[]): Promise<void> {
  if (feedItemIds.length === 0) return;
  debug(`Marking ${feedItemIds.length} feed item(s) as SEEN`);

  for (const batch of chunks(feedItemIds, 50)) {
    const response = await spotifyGraphQL.Request(
      definitions.SetItemsStateInWhatsNewFeed,
      {
        items: {
          items: batch.map((id) => ({
            id,
            state: "SEEN",
          })),
        },
      },
    );
    debugResponse(
      `GraphQL SetItemsStateInWhatsNewFeed response (batch=${batch.length})`,
      response,
    );
  }
}

async function runSync(options?: { force?: boolean }): Promise<void> {
  const force = options?.force === true;
  if (isRunning) {
    debug("Sync skipped: previous sync still running");
    return;
  }
  if (!force && !getBoolSetting(ENABLED_KEY, true)) {
    debug("Sync skipped: extension disabled", false);
    return;
  }
  if (force) {
    debug("Force sync enabled: bypassing auto-save toggle", false);
  }
  isRunning = true;

  try {
    debug("Starting sync");
    const feedItems = await queryWhatsNewFeedItems();
    if (feedItems.length === 0) {
      debug("No feed items returned");
      return;
    }
    debug(`Fetched ${feedItems.length} feed item(s)`);

    const processedFeedIds = getProcessedIds();
    const bypassProcessedCache = force;
    if (bypassProcessedCache) {
      debug("Force sync enabled: bypassing processed-items cache", false);
    }
    const myPlaylists = await getAllMyPlaylists();
    debug(`Found ${myPlaylists.length} owned playlist(s)`);
    const existingTracksByPlaylist = new Map<string, TrackSnapshot>();
    const likedSongsSnapshot = await getLikedSongsSnapshot();
    const feedIdsToMarkSeen: string[] = [];
    const feedIdsToMarkSeenSet = new Set<string>();
    let releasesHandled = 0;
    let tracksHandled = 0;
    let skippedProcessed = 0;
    let skippedNonAlbum = 0;
    let skippedInvalidAlbum = 0;
    let skippedNoArtists = 0;

    type PendingRelease = {
      feedItemId: string;
      albumUri: string;
      albumName: string;
      artistNames: string[];
    };

    const pendingReleases: PendingRelease[] = [];
    for (const item of feedItems) {
      if (!item.id) continue;
      if (!bypassProcessedCache && processedFeedIds.has(item.id)) {
        skippedProcessed += 1;
        continue;
      }
      if (item.content?.__typename !== "AlbumResponseWrapper") {
        skippedNonAlbum += 1;
        continue;
      }

      const album = item.content.data;
      if (!album || album.__typename !== "Album" || !album.uri) {
        skippedInvalidAlbum += 1;
        continue;
      }

      const artistItems = album.artists?.items ?? [];
      const artistData = artistItems
        .map((artist) => {
          if (!artist.uri || !artist.profile?.name) return null;
          return { artistUri: artist.uri, artistName: artist.profile.name };
        })
        .filter((artist): artist is { artistUri: string; artistName: string } =>
          Boolean(artist),
        );

      if (artistData.length === 0) {
        skippedNoArtists += 1;
        continue;
      }

      if (item.state?.state) {
        debug(
          `Feed item state is "${item.state.state}" (processing anyway)`,
          false,
        );
      }
      pendingReleases.push({
        feedItemId: item.id,
        albumUri: album.uri,
        albumName: album.name ?? album.uri,
        artistNames: artistData.map((artist) => artist.artistName),
      });
    }

    const releaseTracksByFeedItem = new Map<string, TrackFingerprint[]>();
    for (const release of pendingReleases) {
      try {
        debug(`Loading release tracks: ${release.albumName}`);
        const tracks = dedupeTracksPreferringExplicit(
          await getAllAlbumTracks(release.albumUri),
        );
        releaseTracksByFeedItem.set(release.feedItemId, tracks);
        if (tracks.length === 0) {
          debug("Release has no tracks, marking as processed");
          processedFeedIds.add(release.feedItemId);
          feedIdsToMarkSeenSet.add(release.feedItemId);
          continue;
        }
        releasesHandled += 1;
        debug(
          `Release track count (deduped explicit-first): ${tracks.length}`,
          false,
        );
      } catch (error) {
        console.error(`${EXTENSION_NAME}: failed loading release tracks`, {
          itemId: release.feedItemId,
          albumUri: release.albumUri,
          error,
        });
      }
    }

    const allReleaseTracks = dedupeTracksPreferringExplicit(
      pendingReleases.flatMap(
        (release) => releaseTracksByFeedItem.get(release.feedItemId) ?? [],
      ),
    );
    debug(
      `Total feed tracks after global dedupe (explicit-first): ${allReleaseTracks.length}`,
      false,
    );

    let likedToAddUris: string[] = [];
    if (likedSongsSnapshot) {
      const likedToAddTracks = collectAddableTracks(
        allReleaseTracks,
        likedSongsSnapshot,
      );
      likedToAddUris = likedToAddTracks.map((track) => track.uri);
      if (likedToAddTracks.length > 0) {
        await likeTracks(likedToAddUris);
        addTracksToSnapshot(likedSongsSnapshot, likedToAddTracks);
      }
    } else {
      likedToAddUris = await getUnlikedTrackUris(
        allReleaseTracks.map((track) => track.uri),
      );
      if (likedToAddUris.length > 0) {
        await likeTracks(likedToAddUris);
      }
    }
    if (likedToAddUris.length === 0) {
      debug(
        "All feed tracks already in Liked Songs (or equivalent duplicates)",
      );
    }
    tracksHandled += likedToAddUris.length;

    const candidateTracksByPlaylist = new Map<string, TrackFingerprint[]>();
    for (const release of pendingReleases) {
      const releaseTracks =
        releaseTracksByFeedItem.get(release.feedItemId) ?? [];
      if (releaseTracks.length === 0) continue;
      const matchingPlaylists = findMatchingPlaylists(
        myPlaylists,
        release.artistNames,
      );
      debug(
        `Artist(s): ${release.artistNames.join(", ")} | Matching playlist(s): ${matchingPlaylists.map((p) => p.name).join(" | ") || "none"}`,
        false,
      );
      for (const playlist of matchingPlaylists) {
        const existing = candidateTracksByPlaylist.get(playlist.uri) ?? [];
        existing.push(...releaseTracks);
        candidateTracksByPlaylist.set(playlist.uri, existing);
      }
      if (matchingPlaylists.length === 0) {
        debug(
          "No matching playlists for this release; only updated Liked Songs",
          false,
        );
      }
    }

    for (const [
      playlistUri,
      playlistTracks,
    ] of candidateTracksByPlaylist.entries()) {
      const dedupedTracks = dedupeTracksPreferringExplicit(playlistTracks);
      await addTracksToPlaylistDeduped(
        playlistUri,
        dedupedTracks,
        existingTracksByPlaylist,
      );
    }

    for (const release of pendingReleases) {
      if (!releaseTracksByFeedItem.has(release.feedItemId)) continue;
      processedFeedIds.add(release.feedItemId);
      feedIdsToMarkSeenSet.add(release.feedItemId);
    }
    feedIdsToMarkSeen.push(...feedIdsToMarkSeenSet);

    await markFeedItemsSeen(feedIdsToMarkSeen);
    setProcessedIds(processedFeedIds);
    debug(
      `Skip summary: processed=${skippedProcessed}, nonAlbum=${skippedNonAlbum}, invalidAlbum=${skippedInvalidAlbum}, noArtists=${skippedNoArtists}`,
      false,
    );

    if (releasesHandled > 0) {
      notify(
        `Added ${tracksHandled} new tracks to Liked Songs from ${releasesHandled} releases.`,
      );
      debug("Sync completed successfully");
    } else {
      debug("Sync completed: nothing new to process");
    }
  } catch (error) {
    console.error(`${EXTENSION_NAME}: sync failed`, error);
    notify("Sync failed. Check console for details.", true);
  } finally {
    isRunning = false;
  }
}

function updateMenuState(): void {
  const enabled = getBoolSetting(ENABLED_KEY, true);
  if (menuItem) {
    menuItem.isEnabled = enabled;
    setMenuItemLabelSafe(
      menuItem,
      `${EXTENSION_NAME} (${enabled ? "ON" : "OFF"})`,
    );
  }
}

function setupMenu(): void {
  const enabled = getBoolSetting(ENABLED_KEY, true);
  menuItem = new Spicetify.Menu.Item(
    `${EXTENSION_NAME} (${enabled ? "ON" : "OFF"})`,
    enabled,
    (self) => {
      const next = !self.isEnabled;
      self.isEnabled = next;
      setBoolSetting(ENABLED_KEY, next);
      updateMenuState();
      notify(next ? "Enabled" : "Disabled");
    },
  );
  menuItem.register();

  const verboseDebug = getBoolSetting(VERBOSE_DEBUG_KEY, VERBOSE_DEBUG_DEFAULT);
  new Spicetify.Menu.Item(
    `Verbose Debug (${verboseDebug ? "ON" : "OFF"})`,
    verboseDebug,
    (self) => {
      const next = !self.isEnabled;
      self.isEnabled = next;
      setBoolSetting(VERBOSE_DEBUG_KEY, next);
      setMenuItemLabelSafe(self, `Verbose Debug (${next ? "ON" : "OFF"})`);
      notify(next ? "Verbose debug enabled" : "Verbose debug disabled");
    },
  ).register();
}

function startScheduler(): void {
  if (timerId !== null) window.clearInterval(timerId);
  timerId = window.setInterval(() => {
    void runSync();
  }, POLL_INTERVAL_MS);
}

function registerTopbarButton(): void {
  if (!Spicetify?.Topbar?.Button) {
    window.setTimeout(registerTopbarButton, 500);
    return;
  }

  if (topbarButton) {
    topbarButton.element?.remove();
    topbarButton = null;
  }

  // Pattern similar to Lucid: construct the button directly when Topbar is ready.
  topbarButton = new Spicetify.Topbar.Button(
    "WhatsNew Sync",
    SYNC_ICON,
    () => {
      debug("Manual sync triggered");
      void runSync({ force: true });
    },
    false,
    true,
  );
  debug("Topbar sync button registered", false);
}

function initialize(): void {
  if (Spicetify.LocalStorage.get(ENABLED_KEY) === null) {
    setBoolSetting(ENABLED_KEY, true);
  }
  if (Spicetify.LocalStorage.get(VERBOSE_DEBUG_KEY) === null) {
    setBoolSetting(VERBOSE_DEBUG_KEY, VERBOSE_DEBUG_DEFAULT);
  }

  setupMenu();
  updateMenuState();
  startScheduler();
  registerTopbarButton();
  void runSync();
}

function waitForSpicetify(): void {
  if (
    !Spicetify?.GraphQL?.Request ||
    !Spicetify?.Menu?.Item ||
    !Spicetify?.Platform?.PlaylistAPI?.add ||
    !Spicetify?.Platform?.PlaylistAPI?.getContents ||
    !Spicetify?.Platform?.LibraryAPI?.add ||
    !Spicetify?.Platform?.RootlistAPI?.getContents
  ) {
    window.setTimeout(waitForSpicetify, 300);
    return;
  }
  initialize();
}

waitForSpicetify();
