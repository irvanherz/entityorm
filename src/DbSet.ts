import { EntityOrm } from ".";
import { IQueryable, IQueryableState } from "./IQueryable";

export class DbSet<T> implements IQueryable<T> {
  _instance: EntityOrm;
  _filters: Array<(value: T) => boolean> = [];
  _skip = 0;
  _take?: number;
  _map?: (value: T) => any;
  _entityType: new () => T;
  _orders: Array<{ source: string; descending: boolean }> = [];
  _distinct: boolean = false;
  _includes: string[] = [];

  constructor(instance: EntityOrm, entityType: new () => T) {
    this._instance = instance;
    this._entityType = entityType;
  }
  include<K extends keyof T>(navigation: string): IQueryable<T> {
    const clone = this.clone();
    clone._includes = [...clone._includes, navigation]
    return clone;
  }

  filter(predicate: (value: T) => boolean): IQueryable<T> {
    const clone = this.clone();
    clone._filters.push(predicate);
    return clone;
  }

  skip(n: number): IQueryable<T> {
    const clone = this.clone();
    clone._skip = n;
    return clone;
  }

  take(n: number): IQueryable<T> {
    const clone = this.clone();
    clone._take = n;
    return clone;
  }

  map<TResult>(selector: (value: T) => TResult): IQueryable<TResult> {
    const clone = this.clone();
    clone._map = selector;
    return clone as unknown as IQueryable<TResult>;
  }

  distinct(): IQueryable<T> {
    const clone = this.clone();
    clone._distinct = true;
    return clone;
  }

  orderBy(selector: ((value: T) => any) | string): IQueryable<T> {
    const clone = this.clone();
    const source =
      typeof selector === "string" ? selector : selector.toString();
    clone._orders.push({ source, descending: false });
    return clone;
  }

  orderByDescending(selector: ((value: T) => any) | string): IQueryable<T> {
    const clone = this.clone();
    const source =
      typeof selector === "string" ? selector : selector.toString();
    clone._orders.push({ source, descending: true });
    return clone;
  }

  getState(){
    return {
      instance: this._instance,
      entityType: this._entityType,
      map: this._map,
      distinct: this._distinct,
      filters: this._filters,
      includes: this._includes,
      orders: this._orders,
      skip: this._skip,
      take: this._take,
    } as IQueryableState<T>
  }

  async toArray(): Promise<any[]> {
    let rows = await this._instance.source.engine.toArray(this.getState());
    return rows;
  }

  async first(): Promise<T | undefined> {
    const results = await this.take(1).toArray();
    return results[0];
  }

  async count(): Promise<number> {
    const results = await this.toArray();
    return results.length;
  }

  private clone(): DbSet<T> {
    const copy = new DbSet<T>(this._instance, this._entityType!);
    copy._filters = [...this._filters];
    copy._skip = this._skip;
    copy._take = this._take;
    copy._map = this._map;
    copy._orders = [...this._orders];
    copy._distinct = this._distinct;
    copy._includes = this._includes;
    return copy;
  }
}
