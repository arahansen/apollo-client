// Make builtins like Map and Set safe to use with non-extensible objects.
import './fixPolyfills';

import { DocumentNode } from 'graphql';

import { Cache, DataProxy, ApolloCache, Transaction } from 'apollo-cache';

import {
  getFragmentQueryDocument,
  addTypenameToDocument,
} from 'apollo-utilities';

import { HeuristicFragmentMatcher } from './fragmentMatcher';
import {
  ApolloReducerConfig,
  NormalizedCache,
  NormalizedCacheObject,
} from './types';

import { StoreReader } from './readFromStore';
import { StoreWriter } from './writeToStore';

import { DepTrackingCache } from './depTrackingCache';
import { wrap, CacheKeyNode } from './optimism';
import { ObjectCache } from './objectCache';

export interface InMemoryCacheConfig extends ApolloReducerConfig {
  resultCaching?: boolean;
}

const defaultConfig: InMemoryCacheConfig = {
  fragmentMatcher: new HeuristicFragmentMatcher(),
  dataIdFromObject: defaultDataIdFromObject,
  addTypename: true,
  resultCaching: true,
};

export function defaultDataIdFromObject(result: any): string | null {
  if (result.__typename) {
    if (result.id !== undefined) {
      return `${result.__typename}:${result.id}`;
    }
    if (result._id !== undefined) {
      return `${result.__typename}:${result._id}`;
    }
  }
  return null;
}

const hasOwn = Object.prototype.hasOwnProperty;

export class OptimisticCacheLayer extends ObjectCache {
  constructor(
    public readonly optimisticId: string,
    public readonly parent: NormalizedCache,
    public readonly transaction: Transaction<NormalizedCacheObject>,
  ) {
    super(Object.create(null));
  }

  public toObject(): NormalizedCacheObject {
    return this.parent ? {
      ...this.parent.toObject(),
      ...this.data,
    } : this.data;
  }

  public get(dataId: string) {
    if (hasOwn.call(this.data, dataId)) {
      return this.data[dataId];
    }
    if (this.parent) {
      return this.parent.get(dataId);
    }
  }
}

export class InMemoryCache extends ApolloCache<NormalizedCacheObject> {
  private data: NormalizedCache;
  private optimisticData: NormalizedCache;

  protected config: InMemoryCacheConfig;
  private watches = new Set<Cache.WatchOptions>();
  private addTypename: boolean;
  private typenameDocumentCache = new Map<DocumentNode, DocumentNode>();
  private storeReader: StoreReader;
  private storeWriter: StoreWriter;
  private cacheKeyRoot = new CacheKeyNode();

  // Set this while in a transaction to prevent broadcasts...
  // don't forget to turn it back on!
  private silenceBroadcast: boolean = false;

  constructor(config: InMemoryCacheConfig = {}) {
    super();
    this.config = { ...defaultConfig, ...config };

    // backwards compat
    if ((this.config as any).customResolvers) {
      console.warn(
        'customResolvers have been renamed to cacheRedirects. Please update your config as we will be deprecating customResolvers in the next major version.',
      );
      this.config.cacheRedirects = (this.config as any).customResolvers;
    }

    if ((this.config as any).cacheResolvers) {
      console.warn(
        'cacheResolvers have been renamed to cacheRedirects. Please update your config as we will be deprecating cacheResolvers in the next major version.',
      );
      this.config.cacheRedirects = (this.config as any).cacheResolvers;
    }

    this.addTypename = this.config.addTypename;

    this.data = this.config.resultCaching
      ? new DepTrackingCache()
      : new ObjectCache();
    this.optimisticData = this.data;

    this.storeReader = new StoreReader(this.cacheKeyRoot);
    this.storeWriter = new StoreWriter();

    const cache = this;
    const { maybeBroadcastWatch } = cache;
    this.maybeBroadcastWatch = wrap((c: Cache.WatchOptions) => {
      return maybeBroadcastWatch.call(this, c);
    }, {
      makeCacheKey(c: Cache.WatchOptions) {
        if (c.optimistic) {
          // If we're reading optimistic data, it doesn't matter if this.data
          // is a DepTrackingCache, since it will be ignored.
          return;
        }

        if (c.previousResult) {
          // If a previousResult was provided, assume the caller would prefer
          // to compare the previous data to the new data to determine whether
          // to broadcast, so we should disable caching by returning here, to
          // give maybeBroadcastWatch a chance to do that comparison.
          return;
        }

        if (cache.data instanceof DepTrackingCache) {
          // Return a cache key (thus enabling caching) only if we're currently
          // using a data store that can track cache dependencies.
          return cache.cacheKeyRoot.lookup(
            c.query,
            JSON.stringify(c.variables),
          );
        }
      }
    });
  }

  public restore(data: NormalizedCacheObject): this {
    if (data) this.data.replace(data);
    return this;
  }

  public extract(optimistic: boolean = false): NormalizedCacheObject {
    return (optimistic ? this.optimisticData : this.data).toObject();
  }

  public read<T>(options: Cache.ReadOptions): T | null {
    if (options.rootId && this.data.get(options.rootId) === undefined) {
      return null;
    }

    return this.storeReader.readQueryFromStore({
      store: options.optimistic ? this.optimisticData : this.data,
      query: this.transformDocument(options.query),
      variables: options.variables,
      rootId: options.rootId,
      fragmentMatcherFunction: this.config.fragmentMatcher.match,
      previousResult: options.previousResult,
      config: this.config,
    });
  }

  public write(write: Cache.WriteOptions): void {
    this.storeWriter.writeResultToStore({
      dataId: write.dataId,
      result: write.result,
      variables: write.variables,
      document: this.transformDocument(write.query),
      store: this.data,
      dataIdFromObject: this.config.dataIdFromObject,
      fragmentMatcherFunction: this.config.fragmentMatcher.match,
    });

    this.broadcastWatches();
  }

  public diff<T>(query: Cache.DiffOptions): Cache.DiffResult<T> {
    return this.storeReader.diffQueryAgainstStore({
      store: query.optimistic ? this.optimisticData : this.data,
      query: this.transformDocument(query.query),
      variables: query.variables,
      returnPartialData: query.returnPartialData,
      previousResult: query.previousResult,
      fragmentMatcherFunction: this.config.fragmentMatcher.match,
      config: this.config,
    });
  }

  public watch(watch: Cache.WatchOptions): () => void {
    this.watches.add(watch);

    return () => {
      this.watches.delete(watch);
    };
  }

  public evict(query: Cache.EvictOptions): Cache.EvictionResult {
    throw new Error(`eviction is not implemented on InMemory Cache`);
  }

  public reset(): Promise<void> {
    this.data.clear();
    this.broadcastWatches();

    return Promise.resolve();
  }

  public removeOptimistic(idToRemove: string) {
    const toReapply: OptimisticCacheLayer[] = [];

    let layer = this.optimisticData;
    while (layer instanceof OptimisticCacheLayer) {
      if (layer.optimisticId !== idToRemove) {
        toReapply.push(layer);
      }
      layer = layer.parent;
    }

    // Reset this.optimisticData to the first non-OptimisticCacheLayer object,
    // which is almost certainly this.data.
    this.optimisticData = layer;

    // Reapply the layers whose optimistic IDs do not match the removed ID.
    while (toReapply.length > 0) {
      const layer = toReapply.pop();
      this.performTransaction(layer.transaction, layer.optimisticId);
    }

    this.broadcastWatches();
  }

  public performTransaction(
    transaction: Transaction<NormalizedCacheObject>,
    optimisticId?: string,
  ) {
    const { data, silenceBroadcast } = this;
    this.silenceBroadcast = true;

    if (typeof optimisticId === 'string') {
      // Add a new optimistic layer and temporarily make this.data refer to
      // that layer for the duration of the transaction.
      this.data = this.optimisticData = new OptimisticCacheLayer(
        optimisticId,
        this.optimisticData,
        transaction,
      );
    }

    try {
      transaction(this);
    } finally {
      this.silenceBroadcast = silenceBroadcast;
      this.data = data;
    }

    // This broadcast does nothing if this.silenceBroadcast is true:
    this.broadcastWatches();
  }

  public recordOptimisticTransaction(
    transaction: Transaction<NormalizedCacheObject>,
    id: string,
  ) {
    return this.performTransaction(transaction, id);
  }

  public transformDocument(document: DocumentNode): DocumentNode {
    if (this.addTypename) {
      let result = this.typenameDocumentCache.get(document);
      if (!result) {
        result = addTypenameToDocument(document);
        this.typenameDocumentCache.set(document, result);
        // If someone calls transformDocument and then mistakenly passes the
        // result back into an API that also calls transformDocument, make sure
        // we don't keep creating new query documents.
        this.typenameDocumentCache.set(result, result);
      }
      return result;
    }
    return document;
  }

  public readQuery<QueryType, TVariables = any>(
    options: DataProxy.Query<TVariables>,
    optimistic: boolean = false,
  ): QueryType {
    return this.read({
      query: options.query,
      variables: options.variables,
      optimistic,
    });
  }

  public readFragment<FragmentType, TVariables = any>(
    options: DataProxy.Fragment<TVariables>,
    optimistic: boolean = false,
  ): FragmentType | null {
    return this.read({
      query: this.transformDocument(
        getFragmentQueryDocument(options.fragment, options.fragmentName),
      ),
      variables: options.variables,
      rootId: options.id,
      optimistic,
    });
  }

  public writeQuery<TData = any, TVariables = any>(
    options: DataProxy.WriteQueryOptions<TData, TVariables>,
  ): void {
    this.write({
      dataId: 'ROOT_QUERY',
      result: options.data,
      query: this.transformDocument(options.query),
      variables: options.variables,
    });
  }

  public writeFragment<TData = any, TVariables = any>(
    options: DataProxy.WriteFragmentOptions<TData, TVariables>,
  ): void {
    this.write({
      dataId: options.id,
      result: options.data,
      query: this.transformDocument(
        getFragmentQueryDocument(options.fragment, options.fragmentName),
      ),
      variables: options.variables,
    });
  }

  protected broadcastWatches() {
    if (!this.silenceBroadcast) {
      this.watches.forEach((c: Cache.WatchOptions) => {
        this.maybeBroadcastWatch(c);
      });
    }
  }

  // This method is wrapped in the constructor so that it will be called only
  // if the data that would be broadcast has changed.
  private maybeBroadcastWatch(c: Cache.WatchOptions) {
    c.callback(
      this.diff({
        query: c.query,
        variables: c.variables,
        previousResult: c.previousResult && c.previousResult(),
        optimistic: c.optimistic,
      }),
    );
  }
}
