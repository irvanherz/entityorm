import { EntityOrm } from '.'
import { IQueryable, IQueryableState, QueryOperation } from './IQueryable'

export class DbSet<T> implements IQueryable<T> {
  _scope: Record<string, any> = {}
  _ops: QueryOperation<T>[] = []

  constructor(
    private _instance: EntityOrm,
    private _entityType: new () => T
  ) {}

  scope(scp: Record<string, any>): IQueryable<T> {
    this._scope = { ...this._scope, ...scp }
    return this
  }

  include<N extends keyof T>(navigation: N): IQueryable<T> {
    return this._withOp({ type: 'include', data: navigation.toString() })
  }

  filter(predicate: (value: T) => boolean): IQueryable<T> {
    return this._withOp({ type: 'filter', data: predicate })
  }

  skip(n: number): IQueryable<T> {
    return this._withOp({ type: 'skip', data: n })
  }

  take(n: number): IQueryable<T> {
    return this._withOp({ type: 'take', data: n })
  }

  map<TResult>(selector: (value: T) => TResult): IQueryable<TResult> {
    return this._withOp({
      type: 'map',
      data: selector,
    }) as unknown as IQueryable<TResult>
  }

  distinct(): IQueryable<T> {
    return this._withOp({ type: 'distinct', data: true })
  }

  orderBy(selector: ((value: T) => any) | string): IQueryable<T> {
    const fn = typeof selector === 'string' ? (x: any) => x[selector] : selector
    return this._withOp({ type: 'order', data: { fn, direction: 'asc' } })
  }

  orderByDescending(selector: ((value: T) => any) | string): IQueryable<T> {
    const fn = typeof selector === 'string' ? (x: any) => x[selector] : selector
    return this._withOp({ type: 'order', data: { fn, direction: 'desc' } })
  }

  join<O, R>(
    other: IQueryable<O>,
    matcher: (left: T, right: O) => boolean,
    mapper: (left: T, right: O) => R
  ): IQueryable<R> {
    let data: any = { other, matcher, mapper }
    return this._withOp({ type: 'join', data }) as any
  }

  getState(): IQueryableState<T> {
    return {
      instance: this._instance,
      entityType: this._entityType,
      scope: this._scope,
      ops: this._ops,
    }
  }

  async toArray(): Promise<any[]> {
    return this._instance.source.engine.toArray(this.getState())
  }

  async first(): Promise<T | undefined> {
    return (await this.take(1).toArray())[0]
  }

  async count(): Promise<number> {
    return (await this.toArray()).length
  }

  private _withOp(op: QueryOperation<T>): DbSet<T> {
    const clone = this.clone()
    clone._ops.push(op)
    return clone
  }

  private clone(): DbSet<T> {
    const clone = new DbSet<T>(this._instance, this._entityType)
    clone._scope = { ...this._scope }
    clone._ops = [...this._ops]
    return clone
  }
}
