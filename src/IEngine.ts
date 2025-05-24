import { IQueryable, IQueryableState } from "./IQueryable";

export interface IEngine {
  toArray<T>(q: IQueryableState<T>): Promise<T[]>;
  first<T>(q: IQueryableState<T>): Promise<T | undefined>;
  count<T>(q: IQueryable<T>): Promise<number>;
}