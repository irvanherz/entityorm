import { EntityOrm } from '.'

export type QueryOperation<T> =
    | { type: 'map'; data: (value: T) => any }
    | { type: 'filter'; data: (value: T) => boolean }
    | { type: 'skip'; data: number }
    | { type: 'take'; data: number }
    | {
          type: 'order'
          data: { fn: (item: any) => any; direction: 'asc' | 'desc' }
      }
    | { type: 'includes'; data: string }
    | { type: 'distinct'; data: boolean }

export interface IQueryable<T> {
    include<N extends keyof T>(navigation: N): IQueryable<T>
    filter(predicate: (value: T) => boolean): IQueryable<T>
    skip(n: number): IQueryable<T>
    take(n: number): IQueryable<T>
    map<TResult>(selector: (value: T) => TResult): IQueryable<TResult>
    distinct(): IQueryable<T>
    orderBy(selector: ((value: T) => any) | string): IQueryable<T>
    orderByDescending(selector: ((value: T) => any) | string): IQueryable<T>

    toArray(): Promise<any[]>
    first(): Promise<T | undefined>
    count(): Promise<number>
    getState(): IQueryableState<T>
}

export interface IQueryableState<T> {
    instance: EntityOrm
    entityType: new () => T
    ops: QueryOperation<T>[]
}
