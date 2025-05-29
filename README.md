> ⚠️ **EntityORM is still in active development.** Features may change, and breaking changes can occur between versions. Not recommended for production use yet.

# EntityORM

**EntityORM** is a lightweight, expressive ORM (Object-Relational Mapper) for **TypeScript**, inspired by [Entity Framework (EF)](https://learn.microsoft.com/en-us/ef/) but designed specifically for modern JavaScript and TypeScript workflows. It combines **decorator-based entity modeling** with **JavaScript array-like querying syntax**, providing an intuitive and flexible way to interact with your database using familiar language features.

```ts
const users = await db.users
  .filter(u => u.username.includes("john"))
  .map(u => ({ id: u.id, username: u.username }))
  .skip(5)
  .take(10)
  .toArray(); // Executes the query and returns results

```

What sets EntityORM apart is its **deep integration with the JavaScript language itself** — powered by [Acorn](https://github.com/acornjs/acorn), a fast JavaScript parser. This allows EntityORM to transform **actual JavaScript functions** (e.g., `.map()`, `.filter()`, etc.) into **SQL queries**, letting you write code that feels like manipulating an array but executes as an optimized database query behind the scenes.

### 🧩 Built for TypeScript Developers

Most ORMs expose a domain-specific query language or chain of methods that can feel unnatural or verbose. With EntityORM, your database queries look and feel like normal JavaScript logic. This leads to:

- **Cleaner and more intuitive code**
- **Minimal learning curve** for TypeScript developers
- **Powerful static typing** and autocomplete support
- **No need to learn custom query DSLs**

---

## ✨ Highlights

- ✅ **Array-like query chaining** (`.map`, `.filter`, `.take`, `.skip`, `.orderBy`, `.toArray`)
- ✅ **Decorator-based schema definition** with `@Table`, `@Column`, `@HasMany`, `@BelongsTo`, etc.
- ✅ **True JavaScript expression parsing** with Acorn
- ✅ **Automatic SQL generation** from JS logic
- ✅ **Type-safe by design**, thanks to TypeScript generics
- ✅ **PostgreSQL native support** (more DBs coming soon)
- ✅ **Supports primitive operations** like `startsWith`, `includes`, number comparisons, null checks

---

### Why EntityORM?

> "What if you could write database queries that look like you're just filtering an array?"

Many TypeScript developers want a lightweight, EF-style ORM that feels *natural* and *developer-friendly*. EntityORM answers this need by giving you:

- The **developer experience of EF** and LINQ
- The **flexibility of JavaScript**
- The **performance of raw SQL**, compiled automatically

No query builders. No magic strings. Just native, intuitive syntax.

---

<!-- ## 📦 Installation

Install via your favorite package manager:

```bash
pnpm add entityorm
# or
npm install entityorm
```

--- -->

## 🚀 Getting Started

### 1. Define your schema using decorators

```ts
@Table({ name: 'users' })
class User {
  @Column({ name: 'id' })
  id!: number;

  @Column({ name: 'username' })
  username!: string;

  @Column({ name: 'full_name' })
  fullName!: string;

  @Column({ name: 'role' })
  role!: "generic" | "admin" | "super";

  @HasMany(() => Course, {
    foreignKey: 'id',
    principalKey: 'id'
  })
  courses!: Course[];
}
```

---

### 2. Create a model collection class

```ts
class AppDbContext extends EntityOrm {
  users = new DbSet<User>(this, User);

  constructor(source: IDataSource) {
    super(source);
  }
}
```

---

### 3. Setup PostgreSQL connection

```ts
const connString = "postgres://postgres:navri@localhost:5432/gourze";
const source = new PostgresDataSource(connString);
```

---

### 4. Instantiate and query like arrays

```ts
const db = new AppDbContext(source);

const users = await db.users
  .map(u => ({ id: u.id * 8 }))
  .skip(5)
  .toArray();

console.log(JSON.stringify(users, null, 2));
```

---

## 🧠 Primitive Type Query Support

EntityORM lets you use primitive JavaScript expressions inside `.filter()` and `.map()` calls. These expressions are parsed with Acorn and compiled into SQL. You can write expressive, declarative queries using JavaScript string, number, and boolean logic.

### ✅ String operations

```ts
db.users.filter(u => u.username.startsWith("A")).toArray();
// SQL: WHERE username LIKE 'A%'

db.users.filter(u => u.fullName.includes("John")).toArray();
// SQL: WHERE full_name LIKE '%John%'

db.users.filter(u => u.email.endsWith("@gmail.com")).toArray();
// SQL: WHERE email LIKE '%@gmail.com'
```

### ✅ Number comparisons

```ts
db.users.filter(u => u.id > 10).toArray();
// SQL: WHERE id > 10

db.users.filter(u => u.age <= 30).toArray();
// SQL: WHERE age <= 30
```

### ✅ Boolean checks

```ts
db.users.filter(u => u.isActive === true).toArray();
// SQL: WHERE is_active = TRUE
```

### ✅ Null checks

```ts
db.users.filter(u => u.deletedAt == null).toArray();
// SQL: WHERE deleted_at IS NULL
```

---

## 📐 Template Literal and Expression Support

EntityORM allows you to use JavaScript **template literals** and **arithmetic expressions** in `.map()` or `.filter()` functions. These expressions are parsed and converted into valid SQL.

```ts
db.users
  .map(u => ({
    greeting: `Hello, ${u.fullName}. I am ${u.age * 2} years old!`,
  }))
  .toArray();
```

---

Here’s the refined documentation — now focusing purely on **method descriptions**, with a **clear section on deferred execution** under terminal methods:

---

## 📘 `IQueryable<T>` Methods

The `IQueryable<T>` interface provides a composable, chainable API for building query expressions in a fluent and type-safe way, inspired by LINQ and Entity Framework.

All intermediate methods (`filter`, `map`, `join`, etc.) are **deferred** — they collect metadata about the query without executing it. Execution only occurs when you invoke a **terminal method** such as `.toArray()`, `.first()`, or `.count()`.

### 🔧 Chainable Methods

#### `include<N extends keyof T>(navigation: N): IQueryable<T>`

Includes a related entity via a navigation property for eager loading.

#### `filter(predicate: (value: T) => boolean): IQueryable<T>`

Adds a filtering condition to the query. Equivalent to a SQL `WHERE` clause.

#### `skip(n: number): IQueryable<T>`

Skips the first `n` records in the result. Useful for pagination.

#### `take(n: number): IQueryable<T>`

Limits the result to the first `n` records. Often used with `.skip()`.

#### `map<TResult>(selector: (value: T) => TResult): IQueryable<TResult>`

Transforms the query result using a projection function. Analogous to SQL `SELECT`.

#### `distinct(): IQueryable<T>`

Removes duplicate results based on the projected values. Semantics depend on the backend implementation.

#### `orderBy(selector: ((value: T) => any) | string): IQueryable<T>`

Sorts the results in ascending order. The selector can be a function or a property name.

#### `orderByDescending(selector: ((value: T) => any) | string): IQueryable<T>`

Sorts the results in descending order.

#### `join<O, R>(other: IQueryable<O>, matcher: (left: T, right: O) => boolean, resultSelector: (left: T, right: O) => R): IQueryable<R>`

Performs an inner join with another queryable. The `matcher` defines the join condition, and the `resultSelector` shapes the output.

#### `scope(scopes: Record<string, any>): IQueryable<T>`

Injects external variables into the query's scope for use in filters, projections, or computations.

### 🔚 Terminal Methods — Execute the Query

All query operations are **deferred** until one of the following terminal methods is called. These methods trigger SQL generation (or equivalent backend operation) and execute the query:

#### `toArray(): Promise<any[]>`

Executes the query and returns all results as an array.

#### `first(): Promise<T | undefined>`

Executes the query and returns the first result (if any), or `undefined`.

#### `count(): Promise<number>`

Executes the query and returns the number of matching records.

> ⚠️ Until a terminal method is called, no data is fetched or processed — all intermediate calls build a query expression tree internally.

---

## ✨ Features

* ✅ **Array-like syntax**: `.map()`, `.filter()`, `.take()`, `.skip()`, `.orderBy()`, `.toArray()`
* ✅ **Entity-based modeling** with decorators like `@Table`, `@Column`, `@HasMany`, `@BelongsTo`
* ✅ **Acorn-powered parsing** of JavaScript functions into safe, efficient SQL
* ✅ **Primitive operations**: supports `startsWith`, `includes`, `endsWith`, number comparisons, booleans, and null checks
* ✅ **PostgreSQL native support**
* 🚧 Other databases coming soon

---

## 🛠 Acorn Parsing and External Scope Handling

EntityORM leverages **Acorn**, a JavaScript parser, to statically analyze and convert JavaScript expressions inside `.map()` and `.filter()` callbacks into SQL queries. This approach allows you to write native JavaScript code that feels like array operations but runs as optimized SQL in the database.

### Parsing Scope Limitations

Acorn can only parse and understand variables that are explicitly declared or passed into the function’s parameter scope. This means:

* Variables declared **inside** the callback function (e.g., `u` in `.map(u => ...)`) are fully understood.
* **Literal values** and **supported JavaScript expressions** within the callback are parsed correctly.
* However, **variables from outer lexical scopes** (e.g., constants, objects declared outside the `.map()` callback) are not automatically visible to Acorn’s static analysis.

### How to Pass External Variables

To reference external variables within your expressions, EntityORM provides the `.scope()` method. This explicitly injects external variables into the parsing context, enabling Acorn to resolve them during SQL generation:

```ts
const foo = 1;
const bar = { num: 123 };

const users = await db.users
  .scope({ foo, bar })  // Inject external variables into parsing scope
  .map(u => ({
    id: u.id,
    id_foo: u.id * foo,
    id_bar: u.id * bar.num,
  }))
  .skip(5)
  .toArray();
```

### Why This Matters

Without using `.scope()`, Acorn treats external variables as **unknown identifiers** and cannot translate expressions involving them into valid SQL. This limitation exists because Acorn performs static parsing and does not execute your JavaScript code at runtime, so it cannot infer the values of variables outside the callback context.

## 🛠 Other Limitations

* ❌ Currently only supports PostgreSQL
* ❌ `.map()` and `.filter()` are limited to simple field access, literal values, and supported string/number/boolean expressions
* ❌ No support yet for complex joins or subqueries (in development)
* ❌ No aggregation methods (e.g., `count()`, `sum()`, `avg()`) yet

---

## 🔮 Roadmap

* [ ] MySQL & SQLite support
* [ ] Join support: `.include()`, `.leftJoin()`, etc.
* [ ] Transactions
* [ ] Migrations CLI
* [ ] Aggregation functions
* [ ] Relationship loading (eager/lazy)
* [ ] LINQ-like grouping and projections

---

## 📘 License

MIT

---

## 🤝 Contributing

Pull requests and discussions are welcome! Please open an issue or PR if you’d like to contribute features or fixes.