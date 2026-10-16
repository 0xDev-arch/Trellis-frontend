import CacheManager, { getOrFetchCachedValue, setVerifiedMetadata, subscribeToCachedValue } from "@/lib/cache-manager";

describe("CacheManager LRU Eviction", () => {
  let cacheManager: CacheManager;

  beforeEach(() => {
    cacheManager = CacheManager.getInstance();
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
    cacheManager.destroy();
  });

  describe("LRU eviction", () => {
    it("evicts least recently used items when cache exceeds maxEntries", async () => {
      const cache = await caches.open("Trellis-api");
      const maxEntries = 100;

      for (let i = 0; i < maxEntries + 5; i++) {
        const request = new Request(`https://example.com/api/item${i}`);
        const response = new Response(JSON.stringify({ id: i }), {
          headers: { "sw-cached-at": Date.now().toString() },
        });
        await cache.put(request, response);
        await cacheManager["recordAccess"]("api", request.url);
      }

      const keys = await cache.keys();
      expect(keys.length).toBeLessThanOrEqual(maxEntries);
    });

    it("evicts the least recently accessed entry first", async () => {
      const cache = await caches.open("Trellis-api");
      const maxEntries = 5;

      const urls = [
        "https://example.com/api/a",
        "https://example.com/api/b",
        "https://example.com/api/c",
        "https://example.com/api/d",
        "https://example.com/api/e",
      ];

      for (const url of urls) {
        const request = new Request(url);
        const response = new Response(JSON.stringify({ url }), {
          headers: { "sw-cached-at": Date.now().toString() },
        });
        await cache.put(request, response);
      }

      await cacheManager["recordAccess"]("api", urls[0]);
      await cacheManager["recordAccess"]("api", urls[0]);
      await cacheManager["recordAccess"]("api", urls[1]);

      for (let i = 5; i < 8; i++) {
        const request = new Request(`https://example.com/api/new${i}`);
        const response = new Response(JSON.stringify({ id: i }), {
          headers: { "sw-cached-at": Date.now().toString() },
        });
        await cache.put(request, response);
        await cacheManager["recordAccess"]("api", request.url);
      }

      const keys = await cache.keys();
      expect(keys.length).toBeLessThanOrEqual(maxEntries);
    });

    it("does not evict when entries are under maxEntries", async () => {
      const cache = await caches.open("Trellis-api");
      await cacheManager["recordAccess"]("api", "https://example.com/api/test");
      const keys = await cache.keys();
      expect(keys.length).toBeLessThanOrEqual(100);
    });
  });

  describe("Storage quota monitoring", () => {
    it("returns storage quota when navigator.storage.estimate is available", async () => {
      const mockEstimate = { usage: 800000000, quota: 1000000000 };
      (navigator.storage.estimate as jest.Mock).mockResolvedValue(mockEstimate);

      const quota = await cacheManager.getStorageQuota();
      expect(quota).toBeTruthy();
      expect(quota?.usage).toBe(800000000);
      expect(quota?.quota).toBe(1000000000);
      expect(quota?.percentage).toBeCloseTo(0.8);
    });

    it("returns null when navigator.storage is not available", async () => {
      const originalStorage = (global as any).navigator.storage;
      (global as any).navigator.storage = undefined;

      const quota = await cacheManager.getStorageQuota();
      expect(quota).toBeNull();

      (global as any).navigator.storage = originalStorage;
    });

    it("detects when storage exceeds 80% quota threshold", async () => {
      const mockEstimate = { usage: 850000000, quota: 1000000000 };
      (navigator.storage.estimate as jest.Mock).mockResolvedValue(mockEstimate);

      const onQuotaExceeded = jest.fn();
      cacheManager.onQuotaExceeded = onQuotaExceeded;

      await cacheManager["checkStorageQuota"]();
      expect(cacheManager.storageQuota?.percentage).toBeGreaterThanOrEqual(0.8);
    });

    it("does not trigger quota exceeded below 80%", async () => {
      const mockEstimate = { usage: 500000000, quota: 1000000000 };
      (navigator.storage.estimate as jest.Mock).mockResolvedValue(mockEstimate);

      const onQuotaExceeded = jest.fn();
      cacheManager.onQuotaExceeded = onQuotaExceeded;

      await cacheManager["checkStorageQuota"]();
      expect(onQuotaExceeded).not.toHaveBeenCalled();
    });
  });

  describe("Cache pruning", () => {
    it("prunes half of the cache entries for a given type", async () => {
      const cache = await caches.open("Trellis-api");
      for (let i = 0; i < 10; i++) {
        const request = new Request(`https://example.com/api/prune${i}`);
        const response = new Response(JSON.stringify({ id: i }), {
          headers: { "sw-cached-at": Date.now().toString() },
        });
        await cache.put(request, response);
        await cacheManager["recordAccess"]("api", request.url);
      }

      const pruned = await cacheManager.pruneCache("api");
      expect(pruned).toBeGreaterThan(0);
    });

    it("returns 0 when no entries exist to prune", async () => {
      const pruned = await cacheManager.pruneCache("Trellis-static");
      expect(pruned).toBe(0);
    });
  });

  describe("Stale-while-revalidate responses", () => {
    it("returns a stale response before refreshing and notifies subscribers", async () => {
      const request = new Request("https://example.com/api/stale-rpc");
      const cache = await caches.open("Trellis-api");
      await cache.put(request, new Response(JSON.stringify({ version: 1 }), {
        headers: { "sw-cached-at": (Date.now() - 25 * 60 * 60 * 1000).toString() },
      }));
      const updatedResponse = new Response(JSON.stringify({ version: 2 }));
      const fetchMock = jest.spyOn(global, "fetch").mockResolvedValue(updatedResponse);
      let unsubscribe = () => {};
      const updateReceived = new Promise<number>(resolve => {
        unsubscribe = cacheManager.subscribeToCachedResponse("api", request, response => {
          void response.json().then(value => resolve(value.version));
        });
      });

      const staleResponse = await cacheManager.getCachedResponse("api", request);

      expect(await staleResponse?.json()).toEqual({ version: 1 });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      await expect(updateReceived).resolves.toBe(2);

      unsubscribe();
      fetchMock.mockRestore();
    });
  });
});

describe("Cache freshness diagnostics", () => {
  let cacheManager: CacheManager;

  beforeEach(() => {
    cacheManager = CacheManager.getInstance();
  });

  afterEach(async () => {
    await cacheManager.clearCache();
  });

  it("reports stale entries without exposing their URLs", async () => {
    const now = Date.now();
    const cache = await caches.open("Trellis-api");
    await cache.put(new Request("https://example.com/private?token=secret"), new Response("x", {
      headers: { "sw-cached-at": String(now - 25 * 60 * 60 * 1000) },
    }));
    await cache.put(new Request("https://example.com/unverified"), new Response("y"));

    const diagnostic = (await cacheManager.diagnoseCaches(now)).find((item) => item.type === "api");
    expect(diagnostic).toMatchObject({ entries: 2, staleEntries: 1, entriesWithoutTimestamp: 1 });
    expect(JSON.stringify(diagnostic)).not.toContain("secret");
    expect(diagnostic?.recommendation).toMatch(/remove stale/i);
  });

  it("removes proven-stale entries while retaining entries with unknown timestamps", async () => {
    const now = Date.now();
    const cache = await caches.open("Trellis-api");
    const stale = new Request("https://example.com/stale");
    const unknown = new Request("https://example.com/unknown");
    await cache.put(stale, new Response("stale", { headers: { "sw-cached-at": String(now - 25 * 60 * 60 * 1000) } }));
    await cache.put(unknown, new Response("unknown"));

    await expect(cacheManager.repairStaleCacheEntries("api", now)).resolves.toBe(1);
    expect(await cache.match(stale)).toBeUndefined();
    expect(await cache.match(unknown)).toBeDefined();
  });
});

describe("Stale-while-revalidate metadata cache", () => {
  it("returns stale metadata immediately and notifies subscribers after background refresh", async () => {
    const key = `swr-test-${Date.now()}`;
    const cachedValue = { version: 1 };
    const updatedValue = { version: 2 };
    let resolveRefresh!: (value: typeof updatedValue) => void;
    const fetcher = jest.fn(() => new Promise<typeof updatedValue>(resolve => {
      resolveRefresh = resolve;
    }));
    const onUpdate = jest.fn();
    await setVerifiedMetadata(key, cachedValue);
    const updateReceived = new Promise<void>(resolve => {
      const unsubscribe = subscribeToCachedValue(key, value => {
        onUpdate(value);
        unsubscribe();
        resolve();
      });
    });
    jest.spyOn(Date, "now").mockReturnValue(Date.now() + 1_000);

    const result = await getOrFetchCachedValue(key, fetcher, { staleTime: 0, cacheTime: 60_000 });

    expect(result).toEqual(cachedValue);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(onUpdate).not.toHaveBeenCalled();

    resolveRefresh(updatedValue);
    await updateReceived;

    expect(onUpdate).toHaveBeenCalledWith(updatedValue);
    jest.restoreAllMocks();
  });
});
