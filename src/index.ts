import 'reflect-metadata'
import { IDataSource } from './IDataSource'

export class EntityOrm {
  public readonly source: IDataSource

  constructor(source: IDataSource) {
    this.source = source
  }
}

export { Column, HasMany, Table } from './attributes'
export { DbSet } from './DbSet'
export { IDataSource } from './IDataSource'
export { IEngine } from './IEngine'
export { IQueryable, IQueryableState, QueryOperation } from './IQueryable'
export { PostgresDataSource, PostgresEngine } from './postgres'
