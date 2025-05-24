import { EntityOrm } from ".";

export interface IQueryable<T> {
  include(navigation: string): IQueryable<T>;
  filter(predicate: (value: T) => boolean): IQueryable<T>;
  skip(n: number): IQueryable<T>;
  take(n: number): IQueryable<T>;
  map<TResult>(selector: (value: T) => TResult): IQueryable<TResult>;
  distinct(): IQueryable<T>;
  orderBy(selector: ((value: T) => any) | string): IQueryable<T>;
  orderByDescending(selector: ((value: T) => any) | string): IQueryable<T>;

  toArray(): Promise<T[]>;
  first(): Promise<T | undefined>;
  count(): Promise<number>;
  getState(): IQueryableState<T>;
}

export interface IQueryableState<T> {
    instance: EntityOrm;
    filters: Array<(value: T) => boolean>
    skip: number;
    take?: number;
    map?: (value: T) => any;
    entityType: new () => T;
    orders: Array<{ source: string; descending: boolean }>
    distinct: boolean
    includes: string[]
}