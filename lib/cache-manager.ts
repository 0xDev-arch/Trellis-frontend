interface CacheConfig {
  name: string;
  version: string;
  maxAge: number;
  maxEntries: number;
  maxSizeBytes?: number;
}

interface CacheEntry {
  url: string;
  timestamp: number;
  lastAccessed: number;
  response: Response;
  sizeBytes: number;
}

interface StorageQuota {
  usage: number;
  quota: number;
  percentage: number;
}

export interface CacheDiagnostic {
  type: string;
  entries: number;
  staleEntries: number;
  entriesWithoutTimestamp: number;
  oldestAgeMs: number | null;
  recommendation: string;
}

const STORAGE_QUOTA_THRESHOLD = 0.8;
const QUOTA_CHECK_INTERVAL_MS = 30000;

class CacheManager {
  private static instance: CacheManager;
  private cacheConfigs: Map<string, CacheConfig> = new Map();
  private lruOrder: Map<string, number> = new Map();
  private accessCounter: number = 0;
  private quotaTimer: ReturnType<typeof setInterval> | null = null;
  private storageQuota: StorageQuota | null = null;
  private responseSubscribers = new Map<string, Set<(response: Response) => void>>();
  private responseRevalidations = new Map<string, Promise<void>>();

  public onQuotaExceeded: ((quota: StorageQuota) => void) | null = null;

  private constructor() {
    this.initializeCacheConfigs();
    this.startQuotaMonitoring();
  }

  public destroy(): void {
    if (this.quotaTimer) {
      clearInterval(this.quotaTimer);
      this.quotaTimer = null;
    }
  }

  public static getInstance(): CacheManager {
    if (!CacheManager.instance) {
      CacheManager.instance = new CacheManager();
    }
    return CacheManager.instance;
  }

  private initializeCacheConfigs() {
    this.cacheConfigs.set('static', {
      name: 'Trellis-static',
      version: 'v1.0.0',
      maxAge: 30 * 24 * 60 * 60,
      maxEntries: 200,
      maxSizeBytes: 50 * 1024 * 1024,
    });

    this.cacheConfigs.set('api', {
      name: 'Trellis-api',
      version: 'v1.0.0',
      maxAge: 24 * 60 * 60,
      maxEntries: 100,
      maxSizeBytes: 20 * 1024 * 1024,
    });

    this.cacheConfigs.set('images', {
      name: 'Trellis-images',
      version: 'v1.0.0',
      maxAge: 90 * 24 * 60 * 60,
      maxEntries: 500,
      maxSizeBytes: 100 * 1024 * 1024,
    });

    this.cacheConfigs.set('fonts', {
      name: 'Trellis-fonts',
      version: 'v1.0.0',
      maxAge: 365 * 24 * 60 * 60,
      maxEntries: 50,
      maxSizeBytes: 10 * 1024 * 1024,
    });
  }

  private startQuotaMonitoring(): void {
    if (typeof window === 'undefined' || !navigator.storage || !navigator.storage.estimate) {
      return;
    }

    this.checkStorageQuota();
    this.quotaTimer = setInterval(() => this.checkStorageQuota(), QUOTA_CHECK_INTERVAL_MS);
  }

  private async checkStorageQuota(): Promise<void> {
    try {
      const estimate = await navigator.storage.estimate();
      const usage = (estimate.usage || 0) as number;
      const quota = (estimate.quota || 1) as number;
      const percentage = quota > 0 ? usage / quota : 0;

      this.storageQuota = { usage, quota, percentage };

      if (percentage >= STORAGE_QUOTA_THRESHOLD) {
        await this.evictCacheForQuota();
        if (this.onQuotaExceeded) {
          this.onQuotaExceeded(this.storageQuota);
        }
      }
    } catch (error) {
      console.warn('[Cache Manager] Failed to check storage quota:', error);
    }
  }

  private async evictCacheForQuota(): Promise<void> {
    for (const [type, config] of this.cacheConfigs) {
      const cache = await caches.open(config.name);
      const keys = await cache.keys();
      if (keys.length === 0) continue;

      const lruSorted = this.getLRUSortedKeys(type, keys);
      const entriesToRemove = lruSorted.slice(0, Math.ceil(keys.length * 0.2));
      for (const request of entriesToRemove) {
        await cache.delete(request);
        this.lruOrder.delete(`${type}:${request.url}`);
      }
    }
  }

  private getLRUSortedKeys(type: string, keys: Request[]): Request[] {
    return keys.sort((a, b) => {
      const aAccess = this.lruOrder.get(`${type}:${a.url}`) || 0;
      const bAccess = this.lruOrder.get(`${type}:${b.url}`) || 0;
      return aAccess - bAccess;
    });
  }

  private recordAccess(type: string, url: string): void {
    this.accessCounter++;
    this.lruOrder.set(`${type}:${url}`, this.accessCounter);
  }

  public async getStorageQuota(): Promise<StorageQuota | null> {
    if (!navigator.storage || !navigator.storage.estimate) {
      return null;
    }
    try {
      const estimate = await navigator.storage.estimate();
      const usage = (estimate.usage || 0) as number;
      const quota = (estimate.quota || 1) as number;
      return { usage, quota, percentage: quota > 0 ? usage / quota : 0 };
    } catch {
      return null;
    }
  }

  public async pruneCache(type: string): Promise<number> {
    const config = this.cacheConfigs.get(type);
    if (!config) return 0;

    const cache = await caches.open(config.name);
    const keys = await cache.keys();
    let pruned = 0;

    const lruSorted = this.getLRUSortedKeys(type, keys);
    const halfCount = Math.ceil(keys.length / 2);
    for (const request of lruSorted.slice(0, halfCount)) {
      const deleted = await cache.delete(request);
      if (deleted) {
        this.lruOrder.delete(`${type}:${request.url}`);
        pruned++;
      }
    }

    return pruned;
  }

  public async getCacheKey(type: string, url: string): Promise<string> {
    const config = this.cacheConfigs.get(type);
    if (!config) {
      throw new Error(`Unknown cache type: ${type}`);
    }
    return `${config.name}-${config.version}-${url}`;
  }

  public async cacheResponse(type: string, request: Request, response: Response): Promise<void> {
    const config = this.cacheConfigs.get(type);
    if (!config) {
      throw new Error(`Unknown cache type: ${type}`);
    }

    const cache = await caches.open(config.name);
    const cacheKey = await this.getCacheKey(type, request.url);

    const responseClone = response.clone();
    const headers = new Headers(responseClone.headers);
    headers.set('sw-cached-at', Date.now().toString());

    const modifiedResponse = new Response(responseClone.body, {
      status: responseClone.status,
      statusText: responseClone.statusText,
      headers: headers,
    });

    await cache.put(request, modifiedResponse.clone());
    this.recordAccess(type, request.url);
    await this.cleanupCache(config.name, config.maxEntries);
    this.notifyResponseSubscribers(type, request, modifiedResponse);
  }

  public async getCachedResponse(type: string, request: Request, options: CacheOptions = {}): Promise<Response | null> {
    const config = this.cacheConfigs.get(type);
    if (!config) {
      throw new Error(`Unknown cache type: ${type}`);
    }

    const cache = await caches.open(config.name);
    const cachedResponse = await cache.match(request);
    this.recordAccess(type, request.url);

    if (!cachedResponse) {
      return null;
    }

    const cachedAt = cachedResponse.headers.get('sw-cached-at');
    if (cachedAt) {
      const cacheAge = (Date.now() - parseInt(cachedAt)) / 1000;
      const staleTime = options.staleTime ?? config.maxAge * 1000;
      const cacheTime = options.cacheTime ?? config.maxAge * 2000;
      if (cacheAge > cacheTime / 1000) {
        await cache.delete(request);
        return null;
      }
      if (cacheAge > staleTime / 1000) {
        void this.revalidateCachedResponse(type, request);
      }
    }

    return cachedResponse;
  }

  public subscribeToCachedResponse(
    type: string,
    request: Request,
    listener: (response: Response) => void
  ): () => void {
    const key = this.getResponseSubscriberKey(type, request);
    const listeners = this.responseSubscribers.get(key) ?? new Set<(response: Response) => void>();
    listeners.add(listener);
    this.responseSubscribers.set(key, listeners);

    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.responseSubscribers.delete(key);
    };
  }

  private getResponseSubscriberKey(type: string, request: Request): string {
    return `${type}:${request.url}`;
  }

  private notifyResponseSubscribers(type: string, request: Request, response: Response): void {
    for (const listener of this.responseSubscribers.get(this.getResponseSubscriberKey(type, request)) ?? []) {
      try {
        listener(response.clone());
      } catch (error) {
        console.error('[Cache Manager] Cache response subscriber failed:', error);
      }
    }
  }

  private async revalidateCachedResponse(type: string, request: Request): Promise<void> {
    const key = this.getResponseSubscriberKey(type, request);
    const pending = this.responseRevalidations.get(key);
    if (pending) return pending;

    const revalidation = (async () => {
      try {
        const response = await fetch(request);
        if (response.ok) await this.cacheResponse(type, request, response);
      } catch (error) {
        console.warn('[Cache Manager] Background cache revalidation failed:', error);
      }
    })().finally(() => this.responseRevalidations.delete(key));
    this.responseRevalidations.set(key, revalidation);
    return revalidation;
  }

  public async clearCache(type?: string): Promise<void> {
    if (type) {
      const config = this.cacheConfigs.get(type);
      if (config) {
        const cache = await caches.open(config.name);
        await cache.keys().then(keys => {
          return Promise.all(keys.map(key => cache.delete(key)));
        });
      }
    } else {
      // Clear all caches
      const cacheNames = await caches.keys();
      await Promise.all(
        cacheNames
          .filter(name => name.startsWith('Trellis-'))
          .map(name => caches.delete(name))
      );
    }
  }

  public async getCacheStats(): Promise<Record<string, any>> {
    const stats: Record<string, any> = {};
    
    for (const [type, config] of this.cacheConfigs) {
      const cache = await caches.open(config.name);
      const keys = await cache.keys();
      
      let totalSize = 0;
      let oldestEntry = Date.now();
      let newestEntry = 0;
      
      for (const request of keys) {
        const response = await cache.match(request);
        if (response) {
          const cachedAt = response.headers.get('sw-cached-at');
          if (cachedAt) {
            const timestamp = parseInt(cachedAt);
            oldestEntry = Math.min(oldestEntry, timestamp);
            newestEntry = Math.max(newestEntry, timestamp);
          }
          
          const responseClone = response.clone();
          const text = await responseClone.text();
          totalSize += text.length;
        }
      }
      
      stats[type] = {
        name: config.name,
        entries: keys.length,
        maxEntries: config.maxEntries,
        estimatedSize: totalSize,
        maxSizeBytes: config.maxSizeBytes,
        oldestEntry: oldestEntry === Date.now() ? null : new Date(oldestEntry),
        newestEntry: newestEntry === 0 ? null : new Date(newestEntry),
        lruOrderLength: this.lruOrder.size,
      };
    }
    
    if (this.storageQuota) {
      stats.storageQuota = this.storageQuota;
    }
    
    return stats;
  }

  /** Inspect this browser's Trellis Cache Storage without exposing cached URLs or values. */
  public async diagnoseCaches(now = Date.now()): Promise<CacheDiagnostic[]> {
    const diagnostics: CacheDiagnostic[] = [];
    for (const [type, config] of this.cacheConfigs) {
      const cache = await caches.open(config.name);
      const keys = await cache.keys();
      let staleEntries = 0;
      let entriesWithoutTimestamp = 0;
      let oldestAgeMs: number | null = null;

      for (const request of keys) {
        const response = await cache.match(request);
        const cachedAt = response?.headers.get('sw-cached-at');
        const timestamp = cachedAt === null || cachedAt === undefined ? NaN : Number(cachedAt);
        if (!Number.isFinite(timestamp) || timestamp <= 0 || timestamp > now) {
          entriesWithoutTimestamp++;
          continue;
        }
        const age = now - timestamp;
        oldestAgeMs = oldestAgeMs === null ? age : Math.max(oldestAgeMs, age);
        if (age > config.maxAge * 1000) staleEntries++;
      }

      diagnostics.push({
        type,
        entries: keys.length,
        staleEntries,
        entriesWithoutTimestamp,
        oldestAgeMs,
        recommendation: staleEntries
          ? 'Remove entries past the configured max age and let the app fetch them again.'
          : entriesWithoutTimestamp
            ? 'Inspect entries without freshness evidence; the automatic repair leaves them untouched.'
            : 'No stale cache entries detected.',
      });
    }
    return diagnostics;
  }

  /** Remove only entries proven stale by the cache's configured max age. */
  public async repairStaleCacheEntries(type?: string, now = Date.now()): Promise<number> {
    const configs = type
      ? [[type, this.cacheConfigs.get(type)] as const]
      : Array.from(this.cacheConfigs.entries());
    let removed = 0;
    for (const [cacheType, config] of configs) {
      if (!config) continue;
      const cache = await caches.open(config.name);
      for (const request of await cache.keys()) {
        const response = await cache.match(request);
        const cachedAt = response?.headers.get('sw-cached-at');
        const timestamp = cachedAt === null || cachedAt === undefined ? NaN : Number(cachedAt);
        if (Number.isFinite(timestamp) && timestamp > 0 && timestamp <= now && now - timestamp > config.maxAge * 1000) {
          if (await cache.delete(request)) {
            this.lruOrder.delete(`${cacheType}:${request.url}`);
            removed++;
          }
        }
      }
    }
    return removed;
  }

  private async cleanupCache(cacheName: string, maxEntries: number): Promise<void> {
    const cache = await caches.open(cacheName);
    const keys = await cache.keys();

    if (keys.length <= maxEntries) {
      return;
    }

    const lruSorted = this.getLRUSortedKeys(cacheName, keys);
    const entriesToRemove = lruSorted.slice(0, keys.length - maxEntries);
    for (const request of entriesToRemove) {
      await cache.delete(request);
      this.lruOrder.delete(`${cacheName}:${request.url}`);
    }
  }

  public async preloadCriticalAssets(): Promise<void> {
    const criticalAssets = [
      '/',
      '/manifest.json',
      '/offline.html',
      '/_next/static/css/app/globals.css',
      '/icons/icon-72x72.png',
      '/icons/icon-96x96.png',
      '/icons/icon-128x128.png',
      '/icons/icon-144x144.png',
      '/icons/icon-152x152.png',
      '/icons/icon-192x192.png',
      '/icons/icon-384x384.png',
      '/icons/icon-512x512.png',
    ];

    // Additional runtime assets
    const runtimeAssets = [
      '/_next/static/chunks/webpack.js',
      '/_next/static/chunks/framework.js',
      '/_next/static/chunks/main.js',
      '/_next/static/chunks/pages/_app.js',
      '/_next/static/chunks/pages/index.js',
    ];

    // Common page routes
    const commonRoutes = [
      '/marketplace',
      '/dashboard',
      '/create',
      '/portfolio',
    ];

    const staticCache = await caches.open('Trellis-static');
    const runtimeCache = await caches.open('Trellis-runtime');
    
    console.log('[Cache Manager] Starting critical asset preloading');
    
    // Preload critical static assets with priority
    const staticPromises = criticalAssets.map(async (asset) => {
      try {
        const response = await fetch(asset, { cache: 'no-store' });
        if (response.ok) {
          const headers = new Headers(response.headers);
          headers.set('sw-cached-at', Date.now().toString());
          
          const modifiedResponse = new Response(response.body, {
            status: response.status,
            statusText: response.statusText,
            headers: headers,
          });
          
          await staticCache.put(asset, modifiedResponse);
          console.log(`[Cache Manager] Preloaded static asset: ${asset}`);
        }
      } catch (error) {
        console.warn(`[Cache Manager] Failed to preload static asset: ${asset}`, error);
      }
    });

    // Preload runtime assets
    const runtimePromises = runtimeAssets.map(async (asset) => {
      try {
        const response = await fetch(asset, { cache: 'no-store' });
        if (response.ok) {
          const headers = new Headers(response.headers);
          headers.set('sw-cached-at', Date.now().toString());
          
          const modifiedResponse = new Response(response.body, {
            status: response.status,
            statusText: response.statusText,
            headers: headers,
          });
          
          await runtimeCache.put(asset, modifiedResponse);
          console.log(`[Cache Manager] Preloaded runtime asset: ${asset}`);
        }
      } catch (error) {
        console.warn(`[Cache Manager] Failed to preload runtime asset: ${asset}`, error);
      }
    });

    // Preload common routes (lower priority)
    const routePromises = commonRoutes.map(async (route) => {
      try {
        const response = await fetch(route, { cache: 'no-store' });
        if (response.ok) {
          const headers = new Headers(response.headers);
          headers.set('sw-cached-at', Date.now().toString());
          
          const modifiedResponse = new Response(response.body, {
            status: response.status,
            statusText: response.statusText,
            headers: headers,
          });
          
          await staticCache.put(route, modifiedResponse);
          console.log(`[Cache Manager] Preloaded route: ${route}`);
        }
      } catch (error) {
        console.warn(`[Cache Manager] Failed to preload route: ${route}`, error);
      }
    });

    // Execute all preloading in parallel with timeout
    await Promise.allSettled([
      ...staticPromises,
      ...runtimePromises,
      ...routePromises
    ]);
    
    console.log('[Cache Manager] Critical asset preloading completed');
  }

  // Advanced cache warming for better performance
  public async warmupCache(): Promise<void> {
    console.log('[Cache Manager] Starting cache warming');
    
    try {
      // Warm up static cache
      await this.preloadCriticalAssets();
      
      // Warm up image cache with common images
      await this.warmupImageCache();
      
      // Warm up font cache
      await this.warmupFontCache();
      
      console.log('[Cache Manager] Cache warming completed');
    } catch (error) {
      console.error('[Cache Manager] Cache warming failed:', error);
    }
  }

  // Warm up image cache with common images
  private async warmupImageCache(): Promise<void> {
    const commonImages = [
      '/icons/icon-192x192.png',
      '/icons/icon-512x512.png',
      // Add other common images used in the app
    ];

    const imageCache = await caches.open('Trellis-images');
    
    const imagePromises = commonImages.map(async (image) => {
      try {
        const response = await fetch(image, { cache: 'no-store' });
        if (response.ok) {
          const headers = new Headers(response.headers);
          headers.set('sw-cached-at', Date.now().toString());
          
          const modifiedResponse = new Response(response.body, {
            status: response.status,
            statusText: response.statusText,
            headers: headers,
          });
          
          await imageCache.put(image, modifiedResponse);
          console.log(`[Cache Manager] Warmed up image: ${image}`);
        }
      } catch (error) {
        console.warn(`[Cache Manager] Failed to warm up image: ${image}`, error);
      }
    });

    await Promise.allSettled(imagePromises);
  }

  // Warm up font cache
  private async warmupFontCache(): Promise<void> {
    const fontUrls = [
      'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap',
      'https://fonts.gstatic.com/s/inter/v12/UcCO3FwrK3iLTeHuS_fvQtMwCp50KnMw2boKoduKmMEVuLyfAZ9hiA.woff2',
    ];

    const fontCache = await caches.open('Trellis-fonts');
    
    const fontPromises = fontUrls.map(async (fontUrl) => {
      try {
        const response = await fetch(fontUrl, { cache: 'no-store' });
        if (response.ok) {
          const headers = new Headers(response.headers);
          headers.set('sw-cached-at', Date.now().toString());
          
          const modifiedResponse = new Response(response.body, {
            status: response.status,
            statusText: response.statusText,
            headers: headers,
          });
          
          await fontCache.put(fontUrl, modifiedResponse);
          console.log(`[Cache Manager] Warmed up font: ${fontUrl}`);
        }
      } catch (error) {
        console.warn(`[Cache Manager] Failed to warm up font: ${fontUrl}`, error);
      }
    });

    await Promise.allSettled(fontPromises);
  }

  // Intelligent cache warming based on user behavior
  public async intelligentWarmup(userRoutes: string[]): Promise<void> {
    console.log('[Cache Manager] Starting intelligent cache warming');
    
    // Prioritize user's frequently accessed routes
    const prioritizedRoutes = userRoutes.slice(0, 10); // Top 10 routes
    
    const staticCache = await caches.open('Trellis-static');
    
    const routePromises = prioritizedRoutes.map(async (route) => {
      try {
        const response = await fetch(route, { cache: 'no-store' });
        if (response.ok) {
          const headers = new Headers(response.headers);
          headers.set('sw-cached-at', Date.now().toString());
          
          const modifiedResponse = new Response(response.body, {
            status: response.status,
            statusText: response.statusText,
            headers: headers,
          });
          
          await staticCache.put(route, modifiedResponse);
          console.log(`[Cache Manager] Intelligently warmed up route: ${route}`);
        }
      } catch (error) {
        console.warn(`[Cache Manager] Failed to intelligently warm up route: ${route}`, error);
      }
    });

    await Promise.allSettled(routePromises);
    console.log('[Cache Manager] Intelligent cache warming completed');
  }

  public async updateCacheVersion(newVersion: string): Promise<void> {
    for (const config of this.cacheConfigs.values()) {
      config.version = newVersion;
    }
    this.lruOrder.clear();

    const cacheNames = await caches.keys();
    const oldCaches = cacheNames.filter(name => 
      name.startsWith('Trellis-') && !name.includes(newVersion)
    );
    
    await Promise.all(oldCaches.map(name => caches.delete(name)));
  }
}

export default CacheManager;

const METADATA_DB = 'trellis-ipfs-metadata';
const METADATA_STORE = 'verified';
const CACHE_ENTRY_MARKER = '__trellisCachedValue';
const DEFAULT_STALE_TIME = 60_000;
const DEFAULT_CACHE_TIME = 5 * 60_000;

export interface CacheOptions {
  staleTime?: number;
  cacheTime?: number;
  onCacheHit?: () => void;
}

interface StoredCacheEntry<T> {
  [CACHE_ENTRY_MARKER]: true;
  value: T;
  cachedAt: number;
}

const memoryMetadata = new Map<string, StoredCacheEntry<unknown>>();
const cacheSubscribers = new Map<string, Set<(value: unknown) => void>>();
const pendingRevalidations = new Map<string, Promise<unknown>>();

function openMetadataDb(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null);
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(METADATA_DB, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(METADATA_STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function getVerifiedMetadata<T>(cid: string): Promise<T | null> {
  const entry = await readCacheEntry<T>(cid, DEFAULT_CACHE_TIME);
  return entry?.value ?? null;
}

export async function setVerifiedMetadata(cid: string, value: unknown): Promise<void> {
  await writeCacheEntry(cid, value);
}

export async function getOrFetchCachedValue<T>(
  key: string,
  fetcher: () => Promise<T>,
  options: CacheOptions = {}
): Promise<T> {
  const staleTime = options.staleTime ?? DEFAULT_STALE_TIME;
  const cacheTime = options.cacheTime ?? DEFAULT_CACHE_TIME;
  const cached = await readCacheEntry<T>(key, cacheTime);

  if (cached) {
    options.onCacheHit?.();
    if (Date.now() - cached.cachedAt > staleTime) {
      void fetchAndStore(key, fetcher).catch(() => undefined);
    }
    return cached.value;
  }

  return fetchAndStore(key, fetcher);
}

export function subscribeToCachedValue<T>(key: string, listener: (value: T) => void): () => void {
  const listeners = cacheSubscribers.get(key) ?? new Set<(value: unknown) => void>();
  listeners.add(listener as (value: unknown) => void);
  cacheSubscribers.set(key, listeners);

  return () => {
    listeners.delete(listener as (value: unknown) => void);
    if (listeners.size === 0) cacheSubscribers.delete(key);
  };
}

export async function clearCachedValues(prefix: string): Promise<void> {
  for (const key of memoryMetadata.keys()) {
    if (key.startsWith(prefix)) memoryMetadata.delete(key);
  }

  const db = await openMetadataDb();
  if (!db) return;
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(METADATA_STORE, 'readwrite');
    const store = transaction.objectStore(METADATA_STORE);
    const request = store.openKeyCursor();
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return;
      if (typeof cursor.key === 'string' && cursor.key.startsWith(prefix)) store.delete(cursor.key);
      cursor.continue();
    };
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
  db.close();
}

async function readCacheEntry<T>(key: string, cacheTime: number): Promise<StoredCacheEntry<T> | null> {
  let entry = memoryMetadata.get(key) as StoredCacheEntry<T> | undefined;

  if (!entry) {
    const db = await openMetadataDb();
    if (!db) return null;
    const stored = await new Promise<unknown>((resolve, reject) => {
      const request = db.transaction(METADATA_STORE, 'readonly').objectStore(METADATA_STORE).get(key);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    db.close();
    if (stored === undefined) return null;

    entry = isStoredCacheEntry<T>(stored)
      ? stored
      : { [CACHE_ENTRY_MARKER]: true, value: stored as T, cachedAt: Date.now() };
    memoryMetadata.set(key, entry);
  }

  if (Date.now() - entry.cachedAt > cacheTime) {
    memoryMetadata.delete(key);
    await deleteCacheEntry(key);
    return null;
  }

  return entry;
}

function isStoredCacheEntry<T>(value: unknown): value is StoredCacheEntry<T> {
  return typeof value === 'object' && value !== null && CACHE_ENTRY_MARKER in value;
}

async function writeCacheEntry(key: string, value: unknown): Promise<void> {
  const entry: StoredCacheEntry<unknown> = {
    [CACHE_ENTRY_MARKER]: true,
    value,
    cachedAt: Date.now(),
  };
  memoryMetadata.set(key, entry);

  const db = await openMetadataDb();
  if (db) {
    await new Promise<void>((resolve, reject) => {
      const request = db.transaction(METADATA_STORE, 'readwrite').objectStore(METADATA_STORE).put(entry, key);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
    db.close();
  }

  for (const listener of cacheSubscribers.get(key) ?? []) {
    try {
      listener(value);
    } catch (error) {
      console.error('[Cache Manager] Cache subscriber failed:', error);
    }
  }
}

async function deleteCacheEntry(key: string): Promise<void> {
  const db = await openMetadataDb();
  if (!db) return;
  await new Promise<void>((resolve, reject) => {
    const request = db.transaction(METADATA_STORE, 'readwrite').objectStore(METADATA_STORE).delete(key);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
  db.close();
}

function fetchAndStore<T>(key: string, fetcher: () => Promise<T>): Promise<T> {
  const pending = pendingRevalidations.get(key) as Promise<T> | undefined;
  if (pending) return pending;

  const request = fetcher()
    .then(async value => {
      await writeCacheEntry(key, value);
      return value;
    })
    .finally(() => pendingRevalidations.delete(key));
  pendingRevalidations.set(key, request);
  return request;
}
