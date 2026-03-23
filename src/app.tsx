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

const EXTENSION_NAME = "WhatsNew Auto Save";
const POLL_INTERVAL_MS = 15 * 60 * 1000;
const FEED_PAGE_SIZE = 50;
const MAX_FEED_PAGES_SAFETY = 400;
const MAX_EMPTY_FEED_PAGES = 2;
const PROCESSED_IDS_KEY = "whatsnew:processed-feed-ids";
const ENABLED_KEY = "whatsnew:enabled";
const VERBOSE_DEBUG_KEY = "whatsnew:verbose-debug";
const VERBOSE_DEBUG_DEFAULT = true;
const SYNC_ICON =
  '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M13.2 4.3a5.8 5.8 0 0 0-9.9 1.6H1.7a.7.7 0 1 0 0 1.4h2.3c.4 0 .7-.3.7-.7V4.2a.7.7 0 1 0-1.4 0v.8A7.2 7.2 0 0 1 15.2 8a.7.7 0 1 0 1.4 0c0-1.4-.4-2.7-1.2-3.7h.8a.7.7 0 0 0 0-1.4h-2.3c-.4 0-.7.3-.7.7v2.3a.7.7 0 1 0 1.4 0v-.6ZM1.4 8a.7.7 0 0 0-1.4 0c0 1.4.4 2.7 1.2 3.7H.4a.7.7 0 1 0 0 1.4h2.3c.4 0 .7-.3.7-.7v-2.3a.7.7 0 1 0-1.4 0v.6A5.8 5.8 0 0 0 11.9 9h1.6a.7.7 0 1 0 0-1.4h-2.3c-.4 0-.7.3-.7.7v2.3a.7.7 0 1 0 1.4 0v-.8A7.2 7.2 0 0 1 1.4 8Z" fill="currentColor"/></svg>';

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
  const maybeSetName = (item as unknown as { setName?: (name: string) => void }).setName;
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

async function getAllAlbumTrackUris(albumUri: string): Promise<string[]> {
  debug(`Loading album tracks: ${albumUri}`, false);
  const query = definitions.queryAlbumTracks;
  const uris: string[] = [];
  let offset = 0;

  while (true) {
    const response = await spotifyGraphQL.Request(query, {
      uri: albumUri,
      offset,
      limit: 100,
    });
    debugResponse(`GraphQL queryAlbumTracks response (album=${albumUri}, offset=${offset})`, response);

    const items = response?.data?.albumUnion?.tracksV2?.items ?? response?.data?.albumUnion?.tracks?.items ?? [];
    if (!items || items.length === 0) break;

    for (const item of items) {
      const track = item?.track ?? item;
      if (typeof track?.uri === "string") uris.push(track.uri);
    }

    if (items.length < 100) break;
    offset += 100;
  }

  return Array.from(new Set(uris));
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
        isOwnedBySelf: typeof item.isOwnedBySelf === "boolean" ? item.isOwnedBySelf : undefined,
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
  const rootlist = await Spicetify.Platform.RootlistAPI.getContents({ limit: 50000 });
  const playlists: PlaylistEntry[] = [];

  if (Array.isArray(rootlist?.items)) {
    collectPlaylists(rootlist.items, playlists);
  }

  return playlists.filter((playlist) => playlist.isOwnedBySelf !== false);
}

async function getPlaylistTrackUriSet(playlistUri: string): Promise<Set<string>> {
  debug(`Reading playlist tracks for duplicate check: ${playlistUri}`, false);
  const contents = await Spicetify.Platform.PlaylistAPI.getContents(playlistUri, { limit: 9999999 });
  const uris = (contents?.items ?? [])
    .map((item: any) => item?.uri)
    .filter((uri: unknown): uri is string => typeof uri === "string");
  return new Set(uris);
}

function parseContainsResponseToBoolArray(response: any, expectedLength: number): boolean[] {
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
      const response = await Spicetify.Platform.LibraryAPI.contains({ uris: batch });
      const contains = parseContainsResponseToBoolArray(response, batch.length);
      for (let i = 0; i < batch.length; i += 1) {
        if (!contains[i]) toAdd.push(batch[i]);
      }
    } catch {
      // Fallback when contains API is unavailable: let add endpoint dedupe server-side.
      debug("Library contains-check unavailable, falling back to direct add dedupe", false);
      toAdd.push(...batch);
    }
  }

  debug(`Liked Songs dedupe: ${trackUris.length} candidate(s), ${toAdd.length} new`);
  return toAdd;
}

function findMatchingPlaylists(playlists: PlaylistEntry[], artistNames: string[]): PlaylistEntry[] {
  const normalizedArtists = new Set(artistNames.map((name) => normalizeName(name)));
  return playlists.filter((playlist) => {
    const namesInPlaylist = splitPlaylistArtistNames(playlist.name);
    return namesInPlaylist.some((name) => normalizedArtists.has(name));
  });
}

async function addTracksToPlaylistDeduped(
  playlistUri: string,
  trackUris: string[],
  existingUrisByPlaylist: Map<string, Set<string>>,
): Promise<number> {
  let existingUris = existingUrisByPlaylist.get(playlistUri);
  if (!existingUris) {
    existingUris = await getPlaylistTrackUriSet(playlistUri);
    existingUrisByPlaylist.set(playlistUri, existingUris);
  }

  const uniqueUris = Array.from(new Set(trackUris));
  const toAdd = uniqueUris.filter((uri) => !existingUris.has(uri));
  if (toAdd.length === 0) {
    debug(`Playlist already up to date: ${playlistUri}`, false);
    return 0;
  }

  for (const batch of chunks(toAdd, 100)) {
    await Spicetify.Platform.PlaylistAPI.add(playlistUri, batch, { after: "end" });
    for (const uri of batch) existingUris.add(uri);
  }

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
      debug(`Stopping feed pagination: offset loop detected at ${offset}`, false);
      break;
    }
    seenOffsets.add(offset);

    debug(`Querying Whats New page ${page + 1} (offset ${offset})`, false);
    const response = await spotifyGraphQL.Request(definitions.queryWhatsNewFeed, {
      offset,
      limit: FEED_PAGE_SIZE,
      onlyUnPlayedItems: false,
      includedContentTypes: [],
    });
    debugResponse(`GraphQL queryWhatsNewFeed response (page=${page + 1}, offset=${offset})`, response);

    const feed = response?.data?.whatsNewFeedItems;
    const items = (feed?.items ?? []) as WhatsNewFeedItem[];
    for (const item of items) {
      if (!item?.id || seenFeedItemIds.has(item.id)) continue;
      seenFeedItemIds.add(item.id);
      allItems.push(item);
    }
    const nextOffset = feed?.pagingInfo?.nextOffset;
    const totalCount = feed?.totalCount;
    const hasExplicitNextOffset = typeof nextOffset === "number" && Number.isFinite(nextOffset);
    const computedNextOffset = offset + FEED_PAGE_SIZE;
    const canFallbackBySize = items.length > 0;
    const fallbackNextOffset = canFallbackBySize ? computedNextOffset : null;

    debug(
      `Feed page ${page + 1}: received ${items.length} item(s), accumulated ${allItems.length}${typeof totalCount === "number" ? ` / total ${totalCount}` : ""}, nextOffset=${String(nextOffset)}, fallbackNextOffset=${String(fallbackNextOffset)}`,
      false,
    );

    if (items.length === 0) {
      consecutiveEmptyPages += 1;
      debug(`Feed page empty (${consecutiveEmptyPages}/${MAX_EMPTY_FEED_PAGES})`, false);
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
      debug("Stopping feed pagination: no valid next offset provided by API", false);
      break;
    }

    offset = next;
    page += 1;
  }

  if (page >= MAX_FEED_PAGES_SAFETY) {
    debug(`Stopped feed pagination at safety cap (${MAX_FEED_PAGES_SAFETY} pages)`, false);
  }

  return allItems;
}

async function markFeedItemsSeen(feedItemIds: string[]): Promise<void> {
  if (feedItemIds.length === 0) return;
  debug(`Marking ${feedItemIds.length} feed item(s) as SEEN`);

  for (const batch of chunks(feedItemIds, 50)) {
    const response = await spotifyGraphQL.Request(definitions.SetItemsStateInWhatsNewFeed, {
      items: {
        items: batch.map((id) => ({
          id,
          state: "SEEN",
        })),
      },
    });
    debugResponse(`GraphQL SetItemsStateInWhatsNewFeed response (batch=${batch.length})`, response);
  }
}

async function runSync(): Promise<void> {
  if (isRunning) {
    debug("Sync skipped: previous sync still running");
    return;
  }
  if (!getBoolSetting(ENABLED_KEY, true)) {
    debug("Sync skipped: extension disabled", false);
    return;
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
    const myPlaylists = await getAllMyPlaylists();
    debug(`Found ${myPlaylists.length} owned playlist(s)`);
    const existingUrisByPlaylist = new Map<string, Set<string>>();
    const feedIdsToMarkSeen: string[] = [];
    let releasesHandled = 0;
    let tracksHandled = 0;

    for (const item of feedItems) {
      if (!item.id || processedFeedIds.has(item.id)) continue;
      if (item.content?.__typename !== "AlbumResponseWrapper") continue;

      const album = item.content.data;
      if (!album || album.__typename !== "Album" || !album.uri) continue;

      const artistItems = album.artists?.items ?? [];
      const artistData = artistItems
        .map((artist) => {
          if (!artist.uri || !artist.profile?.name) return null;
          return { artistUri: artist.uri, artistName: artist.profile.name };
        })
        .filter((artist): artist is { artistUri: string; artistName: string } => Boolean(artist));

      if (artistData.length === 0) continue;

      try {
        debug(`Processing release: ${album.name ?? album.uri}`);
        if (item.state?.state) {
          debug(`Feed item state is "${item.state.state}" (processing anyway)`, false);
        }
        const trackUris = await getAllAlbumTrackUris(album.uri);
        if (trackUris.length === 0) {
          debug("Release has no tracks, marking as processed");
          processedFeedIds.add(item.id);
          feedIdsToMarkSeen.push(item.id);
          continue;
        }
        debug(`Release track count: ${trackUris.length}`);

        const releaseArtistNames = artistData.map((artist) => artist.artistName);
        const matchingPlaylists = findMatchingPlaylists(myPlaylists, releaseArtistNames);
        debug(
          `Artist(s): ${releaseArtistNames.join(", ")} | Matching playlist(s): ${matchingPlaylists.map((p) => p.name).join(" | ") || "none"}`,
        );

        const likedToAdd = await getUnlikedTrackUris(trackUris);
        if (likedToAdd.length > 0) {
          await likeTracks(likedToAdd);
        } else {
          debug("All release tracks already in Liked Songs");
        }

        for (const playlist of matchingPlaylists) {
          await addTracksToPlaylistDeduped(playlist.uri, trackUris, existingUrisByPlaylist);
        }
        if (matchingPlaylists.length === 0) {
          debug("No matching playlists for this release; only updated Liked Songs", false);
        }

        processedFeedIds.add(item.id);
        feedIdsToMarkSeen.push(item.id);
        releasesHandled += 1;
        tracksHandled += likedToAdd.length;
      } catch (error) {
        console.error(`${EXTENSION_NAME}: failed processing release`, {
          itemId: item.id,
          albumUri: album.uri,
          error,
        });
      }
    }

    await markFeedItemsSeen(feedIdsToMarkSeen);
    setProcessedIds(processedFeedIds);

    if (releasesHandled > 0) {
      notify(`Added ${tracksHandled} new tracks to Liked Songs from ${releasesHandled} releases.`);
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
    setMenuItemLabelSafe(menuItem, `${EXTENSION_NAME} (${enabled ? "ON" : "OFF"})`);
  }
}

function setupMenu(): void {
  const enabled = getBoolSetting(ENABLED_KEY, true);
  menuItem = new Spicetify.Menu.Item(`${EXTENSION_NAME} (${enabled ? "ON" : "OFF"})`, enabled, (self) => {
    const next = !self.isEnabled;
    self.isEnabled = next;
    setBoolSetting(ENABLED_KEY, next);
    updateMenuState();
    notify(next ? "Enabled" : "Disabled");
  });
  menuItem.register();

  const verboseDebug = getBoolSetting(VERBOSE_DEBUG_KEY, VERBOSE_DEBUG_DEFAULT);
  new Spicetify.Menu.Item(`Verbose Debug (${verboseDebug ? "ON" : "OFF"})`, verboseDebug, (self) => {
    const next = !self.isEnabled;
    self.isEnabled = next;
    setBoolSetting(VERBOSE_DEBUG_KEY, next);
    setMenuItemLabelSafe(self, `Verbose Debug (${next ? "ON" : "OFF"})`);
    notify(next ? "Verbose debug enabled" : "Verbose debug disabled");
  }).register();
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
    "WN Sync",
    SYNC_ICON,
    () => {
      debug("Manual sync triggered");
      void runSync();
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
