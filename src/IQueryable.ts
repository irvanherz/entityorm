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
  | { type: 'include'; data: string }
  | { type: 'distinct'; data: boolean }
  | {
      type: 'join'
      data: {
        other: IQueryable<any>
        leftKeySelector?: (left: any) => any
        rightKeySelector?: (right: any) => any
        on?: (left: any, right: any) => boolean
        resultSelector: (left: any, right: any) => any
      }
    }

export interface IQueryable<T> {
  include<N extends keyof T>(navigation: N): IQueryable<T>
  filter(predicate: (value: T) => boolean): IQueryable<T>
  skip(n: number): IQueryable<T>
  take(n: number): IQueryable<T>
  map<TResult>(selector: (value: T) => TResult): IQueryable<TResult>
  distinct(): IQueryable<T>
  orderBy(selector: ((value: T) => any) | string): IQueryable<T>
  orderByDescending(selector: ((value: T) => any) | string): IQueryable<T>
  join<O, R>(
    other: IQueryable<O>,
    matcher: (left: T, right: O) => boolean,
    resultSelector: (left: T, right: O) => R
  ): IQueryable<R>
  toArray(): Promise<any[]>
  first(): Promise<T | undefined>
  count(): Promise<number>
  scope(scopes: Record<string, any>): IQueryable<T>
  getState(): IQueryableState<T>
}

export interface IQueryableState<T> {
  instance: EntityOrm
  entityType: new () => T
  scope: Record<string, any>
  ops: QueryOperation<T>[]
}
