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
const MAX_FEED_PAGES = 4;
const PROCESSED_IDS_KEY = "whatsnew:processed-feed-ids";
const ENABLED_KEY = "whatsnew:enabled";

let menuItem: Spicetify.Menu.Item | null = null;
let timerId: number | null = null;
let isRunning = false;

const spotifyGraphQL = Spicetify.GraphQL;
const definitions = spotifyGraphQL.Definitions;

function notify(message: string, isError = false): void {
  Spicetify.showNotification(`${EXTENSION_NAME}: ${message}`, isError, 5000);
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
  const query = definitions.queryAlbumTracks;
  const uris: string[] = [];
  let offset = 0;

  while (true) {
    const response = await spotifyGraphQL.Request(query, {
      uri: albumUri,
      offset,
      limit: 100,
    });

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
  const rootlist = await Spicetify.Platform.RootlistAPI.getContents({ limit: 50000 });
  const playlists: PlaylistEntry[] = [];

  if (Array.isArray(rootlist?.items)) {
    collectPlaylists(rootlist.items, playlists);
  }

  return playlists.filter((playlist) => playlist.isOwnedBySelf !== false);
}

async function getPlaylistTrackUriSet(playlistUri: string): Promise<Set<string>> {
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
      toAdd.push(...batch);
    }
  }

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
  if (toAdd.length === 0) return 0;

  for (const batch of chunks(toAdd, 100)) {
    await Spicetify.Platform.PlaylistAPI.add(playlistUri, batch, { after: "end" });
    for (const uri of batch) existingUris.add(uri);
  }

  return toAdd.length;
}

async function queryWhatsNewFeedItems(): Promise<WhatsNewFeedItem[]> {
  const allItems: WhatsNewFeedItem[] = [];
  let offset = 0;

  for (let page = 0; page < MAX_FEED_PAGES; page += 1) {
    const response = await spotifyGraphQL.Request(definitions.queryWhatsNewFeed, {
      offset,
      limit: FEED_PAGE_SIZE,
      onlyUnPlayedItems: false,
      includedContentTypes: [],
    });

    const items = (response?.data?.whatsNewFeedItems?.items ?? []) as WhatsNewFeedItem[];
    allItems.push(...items);
    if (items.length < FEED_PAGE_SIZE) break;
    offset += FEED_PAGE_SIZE;
  }

  return allItems;
}

async function markFeedItemsSeen(feedItemIds: string[]): Promise<void> {
  if (feedItemIds.length === 0) return;

  for (const batch of chunks(feedItemIds, 50)) {
    await spotifyGraphQL.Request(definitions.SetItemsStateInWhatsNewFeed, {
      items: {
        items: batch.map((id) => ({
          id,
          state: "SEEN",
        })),
      },
    });
  }
}

async function runSync(): Promise<void> {
  if (isRunning) return;
  if (!getBoolSetting(ENABLED_KEY, true)) return;
  isRunning = true;

  try {
    const feedItems = await queryWhatsNewFeedItems();
    if (feedItems.length === 0) return;

    const processedFeedIds = getProcessedIds();
    const myPlaylists = await getAllMyPlaylists();
    const existingUrisByPlaylist = new Map<string, Set<string>>();
    const feedIdsToMarkSeen: string[] = [];
    let releasesHandled = 0;
    let tracksHandled = 0;

    for (const item of feedItems) {
      if (!item.id || processedFeedIds.has(item.id)) continue;
      if (item.state?.state === "SEEN") continue;
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
        const trackUris = await getAllAlbumTrackUris(album.uri);
        if (trackUris.length === 0) {
          processedFeedIds.add(item.id);
          feedIdsToMarkSeen.push(item.id);
          continue;
        }

        const releaseArtistNames = artistData.map((artist) => artist.artistName);
        const matchingPlaylists = findMatchingPlaylists(myPlaylists, releaseArtistNames);

        const likedToAdd = await getUnlikedTrackUris(trackUris);
        if (likedToAdd.length > 0) {
          await likeTracks(likedToAdd);
        }

        for (const playlist of matchingPlaylists) {
          await addTracksToPlaylistDeduped(playlist.uri, trackUris, existingUrisByPlaylist);
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
    menuItem.setName(`${EXTENSION_NAME} (${enabled ? "ON" : "OFF"})`);
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
}

function startScheduler(): void {
  if (timerId !== null) window.clearInterval(timerId);
  timerId = window.setInterval(() => {
    void runSync();
  }, POLL_INTERVAL_MS);
}

function initialize(): void {
  if (Spicetify.LocalStorage.get(ENABLED_KEY) === null) {
    setBoolSetting(ENABLED_KEY, true);
  }

  setupMenu();
  updateMenuState();
  startScheduler();
  void runSync();

  // Quick-access command for manual runs.
  new Spicetify.Topbar.Button("WN Sync", "refresh", () => {
    void runSync();
  });
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
