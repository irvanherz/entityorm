import { EntityOrm } from '..'
import { Column, HasMany, Table } from '../attributes'
import { DbSet } from '../DbSet'
import { IDataSource } from '../IDataSource'
import { parseJoinMatcher, PostgresDataSource } from '../postgres'

@Table({ name: 'courses' })
class Course {
  @Column({ name: 'id' })
  id!: number
  @Column({ name: 'name' })
  name!: string
  @Column({ name: 'description' })
  description!: string
  // @ManyToOne(() => User, user => user.courses)
  user!: User
}

@Table({ name: 'users' })
class User {
  @Column({ name: 'id' })
  id!: number
  @Column({ name: 'username' })
  username!: string
  @Column({ name: 'full_name' })
  fullName!: string
  @Column({ name: 'role' })
  role!: 'generic' | 'admin' | 'super'
  @HasMany(() => Course, { foreignKey: 'id', principalKey: 'id' })
  courses!: Course[]
}

class AppDbContext extends EntityOrm {
  users = new DbSet<User>(this, User)

  constructor(source: IDataSource) {
    super(source)
  }
}

async function main() {
  const connString = 'postgres://postgres:navri@localhost:5432/gourze'
  const source = new PostgresDataSource(connString)
  const db = new AppDbContext(source)

  const foo = 1
  const bar = { num: 123 }

  //expr, leftSelects, rightSelects
  const v = parseJoinMatcher('(a, b) => a.id == b.userId', [
    { alias: 'left.id', target: '0.id' },
    { alias: 'right.userId', target: '0.userId' },
  ])
  // const w = parseJoinMapper('(a, b) => ({ a: a.id, b: b.id })', [
  //   { alias: '0.id', target: '0.id' },
  //   { alias: '1.userId', target: '0.userId' },
  // ])
  console.log(v)
  const users = await db.users
    .scope({ foo, bar })
    .filter((u) => u.id > foo)
    .map((u) => ({
      id: u.id,
      id_foo: u.id * foo,
      id_bar: u.id * bar.num,
      uname: u.username,
      greeting: `Hello, ${u.fullName.toUpperCase()}!`,
    }))
    .orderByDescending((r) => r.uname.toLowerCase())
    .skip(5)
    .toArray()

  console.log('RESULT:\n', JSON.stringify(users, null, 2))
}

main()
