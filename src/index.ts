import "reflect-metadata";
import { IDataSource } from "./IDataSource";

export class EntityOrm {
  public readonly source: IDataSource;

  constructor(source: IDataSource) {
    this.source = source;
  }
}