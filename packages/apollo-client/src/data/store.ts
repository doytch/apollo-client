import { ExecutionResult, DocumentNode } from 'graphql';
import { ApolloCache, Cache, DataProxy } from 'apollo-cache';
import {
  getOperationName,
  tryFunctionOrLogError,
  graphQLResultHasError,
} from 'apollo-utilities';

import { QueryStoreValue } from '../data/queries';
import { MutationQueryReducer, Initializers } from '../core/types';
import ApolloClient from '..';

export type QueryWithUpdater = {
  updater: MutationQueryReducer<Object>;
  query: QueryStoreValue;
};

export interface DataWrite {
  rootId: string;
  result: any;
  document: DocumentNode;
  operationName: string | null;
  variables: Object;
}

export class DataStore<TSerialized> {
  private cache: ApolloCache<TSerialized>;
  private firedInitializers: string[] = [];

  constructor(initialCache: ApolloCache<TSerialized>) {
    this.cache = initialCache;
  }

  public getCache(): ApolloCache<TSerialized> {
    return this.cache;
  }

  public markQueryResult(
    result: ExecutionResult,
    document: DocumentNode,
    variables: any,
    fetchMoreForQueryId: string | undefined,
    ignoreErrors: boolean = false,
  ) {
    let writeWithErrors = !graphQLResultHasError(result);
    if (ignoreErrors && graphQLResultHasError(result) && result.data) {
      writeWithErrors = true;
    }
    if (!fetchMoreForQueryId && writeWithErrors) {
      this.cache.write({
        result: result.data,
        dataId: 'ROOT_QUERY',
        query: document,
        variables: variables,
      });
    }
  }

  public markSubscriptionResult(
    result: ExecutionResult,
    document: DocumentNode,
    variables: any,
  ) {
    // the subscription interface should handle not sending us results we no longer subscribe to.
    // XXX I don't think we ever send in an object with errors, but we might in the future...
    if (!graphQLResultHasError(result)) {
      this.cache.write({
        result: result.data,
        dataId: 'ROOT_SUBSCRIPTION',
        query: document,
        variables: variables,
      });
    }
  }

  public markMutationInit(mutation: {
    mutationId: string;
    document: DocumentNode;
    variables: any;
    updateQueries: { [queryId: string]: QueryWithUpdater };
    update: ((proxy: DataProxy, mutationResult: Object) => void) | undefined;
    optimisticResponse: Object | Function | undefined;
  }) {
    if (mutation.optimisticResponse) {
      let optimistic: Object;
      if (typeof mutation.optimisticResponse === 'function') {
        optimistic = mutation.optimisticResponse(mutation.variables);
      } else {
        optimistic = mutation.optimisticResponse;
      }

      const changeFn = () => {
        this.markMutationResult({
          mutationId: mutation.mutationId,
          result: { data: optimistic },
          document: mutation.document,
          variables: mutation.variables,
          updateQueries: mutation.updateQueries,
          update: mutation.update,
        });
      };

      this.cache.recordOptimisticTransaction(c => {
        const orig = this.cache;
        this.cache = c;

        try {
          changeFn();
        } finally {
          this.cache = orig;
        }
      }, mutation.mutationId);
    }
  }

  public markMutationResult(mutation: {
    mutationId: string;
    result: ExecutionResult;
    document: DocumentNode;
    variables: any;
    updateQueries: { [queryId: string]: QueryWithUpdater };
    update: ((proxy: DataProxy, mutationResult: Object) => void) | undefined;
  }) {
    // Incorporate the result from this mutation into the store
    if (!graphQLResultHasError(mutation.result)) {
      const cacheWrites: Cache.WriteOptions[] = [];
      cacheWrites.push({
        result: mutation.result.data,
        dataId: 'ROOT_MUTATION',
        query: mutation.document,
        variables: mutation.variables,
      });

      if (mutation.updateQueries) {
        Object.keys(mutation.updateQueries)
          .filter(id => mutation.updateQueries[id])
          .forEach(queryId => {
            const { query, updater } = mutation.updateQueries[queryId];
            // Read the current query result from the store.
            const { result: currentQueryResult, complete } = this.cache.diff({
              query: query.document,
              variables: query.variables,
              returnPartialData: true,
              optimistic: false,
            });

            if (!complete) {
              return;
            }

            // Run our reducer using the current query result and the mutation result.
            const nextQueryResult = tryFunctionOrLogError(() =>
              updater(currentQueryResult, {
                mutationResult: mutation.result,
                queryName: getOperationName(query.document) || undefined,
                queryVariables: query.variables,
              }),
            );

            // Write the modified result back into the store if we got a new result.
            if (nextQueryResult) {
              cacheWrites.push({
                result: nextQueryResult,
                dataId: 'ROOT_QUERY',
                query: query.document,
                variables: query.variables,
              });
            }
          });
      }

      this.cache.performTransaction(c => {
        cacheWrites.forEach(write => c.write(write));
      });

      // If the mutation has some writes associated with it then we need to
      // apply those writes to the store by running this reducer again with a
      // write action.
      const update = mutation.update;
      if (update) {
        this.cache.performTransaction(c => {
          tryFunctionOrLogError(() => update(c, mutation.result));
        });
      }
    }
  }

  public markMutationComplete({
    mutationId,
    optimisticResponse,
  }: {
    mutationId: string;
    optimisticResponse?: any;
  }) {
    if (!optimisticResponse) return;
    this.cache.removeOptimistic(mutationId);
  }

  public markUpdateQueryResult(
    document: DocumentNode,
    variables: any,
    newResult: any,
  ) {
    this.cache.write({
      result: newResult,
      dataId: 'ROOT_QUERY',
      variables,
      query: document,
    });
  }

  public reset(): Promise<void> {
    // Allow initializers to be called again after a store reset.
    this.firedInitializers = [];

    return this.cache.reset();
  }

  // Run the incoming initializer functions, asynchronously. Initializers that
  // have already been run are tracked against the initializer field name, to
  // prevent them from being run a second time.
  //
  // Initializer functions are passed a reference to the current
  // `ApolloClient` instance, to get access to the cache (or any other
  // `ApolloClient` properties/functions).
  //
  // NOTE: Initializers do not currently check to see if data already exists
  // in the cache, before writing to the cache. This means existing data
  // can be overwritten. We might decide to query into the cache first to
  // see if any previous data exists before overwritting it, but TBD.
  public initialize(
    initializers: Initializers<TSerialized> | Initializers<TSerialized>[],
    client: ApolloClient<TSerialized>,
  ) {
    if (!initializers) {
      throw new Error('Invalid/missing initializers');
    }

    const mergedInitializers = this.mergeInitializers(initializers);

    const initializerPromises: Promise<void>[] = [];
    this.runInitializers(
      mergedInitializers,
      (fieldName: string, initializer: any) => {
        initializerPromises.push(
          Promise.resolve(initializer(client)).then(result => {
            if (result !== null) {
              this.cache.writeData({ data: { [fieldName]: result } });
            }
          }),
        );
      },
    );

    return Promise.all(initializerPromises);
  }

  // Run incoming intializer functions, synchronously.
  public initializeSync(
    initializers: Initializers<TSerialized> | Initializers<TSerialized>[],
  ) {
    if (!initializers) {
      throw new Error('Invalid/missing initializers');
    }

    const mergedInitializers = this.mergeInitializers(initializers);

    this.runInitializers(
      mergedInitializers,
      (fieldName: string, initializer: any) => {
        const result = initializer(this);
        if (result !== null) {
          this.cache.writeData({ data: { [fieldName]: result } });
        }
      },
    );
  }

  private mergeInitializers(
    initializers: Initializers<TSerialized> | Initializers<TSerialized>[],
  ) {
    let mergedInitializers: Initializers<TSerialized> = {};
    if (Array.isArray(initializers)) {
      initializers.forEach(initializerGroup => {
        mergedInitializers = { ...mergedInitializers, ...initializerGroup };
      });
    } else {
      mergedInitializers = initializers;
    }
    return mergedInitializers;
  }

  private runInitializers(
    initializers: Initializers<TSerialized>,
    runFunc: (fieldName: string, initializer: any) => any,
  ) {
    Object.keys(initializers).forEach(fieldName => {
      if (this.firedInitializers.indexOf(fieldName) < 0) {
        runFunc(fieldName, initializers[fieldName]);
        this.firedInitializers.push(fieldName);
      }
    });
  }
}
