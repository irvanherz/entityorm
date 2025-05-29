import 'reflect-metadata'
import { IDataSource } from './IDataSource'

export class EntityOrm {
  public readonly source: IDataSource

  constructor(source: IDataSource) {
    this.source = source
  }
}

export { DbSet } from './DbSet'
export { IDataSource } from './IDataSource'
export { IEngine } from './IEngine'
export { Table, Column, HasMany } from './attributes'
export { IQueryable, IQueryableState, QueryOperation } from './IQueryable'
export { PostgresDataSource, PostgresEngine } from './postgres'
