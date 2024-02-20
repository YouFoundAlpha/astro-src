import { expect } from 'chai';
import { describe, it } from 'mocha';
import { getCollectionChangeQueries } from '../../dist/core/cli/migration-queries.js';
import { column, defineCollection, collectionsSchema } from '../../dist/core/types.js';

const BaseUser = defineCollection({
	columns: {
		id: column.number({ primaryKey: true }),
		name: column.text(),
		age: column.number(),
		email: column.text({ unique: true }),
		mi: column.text({ optional: true }),
	},
});

const BaseSentBox = defineCollection({
	columns: {
		to: column.number(),
		toName: column.text(),
		subject: column.text(),
		body: column.text(),
	},
});

const defaultAmbiguityResponses = {
	collectionRenames: {},
	columnRenames: {},
};

/**
 * @typedef {import('../../dist/core/types.js').DBCollection} DBCollection
 * @param {{ User: DBCollection, SentBox: DBCollection }} params
 * @returns
 */
function resolveReferences(
	{ User = BaseUser, SentBox = BaseSentBox } = {
		User: BaseUser,
		SentBox: BaseSentBox,
	}
) {
	return collectionsSchema.parse({ User, SentBox });
}

function userChangeQueries(
	oldCollection,
	newCollection,
	ambiguityResponses = defaultAmbiguityResponses
) {
	return getCollectionChangeQueries({
		collectionName: 'User',
		oldCollection,
		newCollection,
		ambiguityResponses,
	});
}

describe('reference queries', () => {
	it('adds references with lossless table recreate', async () => {
		const { SentBox: Initial } = resolveReferences();
		const { SentBox: Final } = resolveReferences({
			SentBox: defineCollection({
				columns: {
					...BaseSentBox.columns,
					to: column.number({ references: () => BaseUser.columns.id }),
				},
			}),
		});

		const { queries } = await userChangeQueries(Initial, Final);

		expect(queries[0]).to.not.be.undefined;
		const tempTableName = getTempTableName(queries[0]);
		expect(tempTableName).to.not.be.undefined;

		expect(queries).to.deep.equal([
			`CREATE TABLE \"${tempTableName}\" (_id INTEGER PRIMARY KEY, \"to\" integer NOT NULL REFERENCES \"User\" (\"id\"), \"toName\" text NOT NULL, \"subject\" text NOT NULL, \"body\" text NOT NULL)`,
			`INSERT INTO \"${tempTableName}\" (\"_id\", \"to\", \"toName\", \"subject\", \"body\") SELECT \"_id\", \"to\", \"toName\", \"subject\", \"body\" FROM \"User\"`,
			'DROP TABLE "User"',
			`ALTER TABLE \"${tempTableName}\" RENAME TO \"User\"`,
		]);
	});

	it('removes references with lossless table recreate', async () => {
		const { SentBox: Initial } = resolveReferences({
			SentBox: defineCollection({
				columns: {
					...BaseSentBox.columns,
					to: column.number({ references: () => BaseUser.columns.id }),
				},
			}),
		});
		const { SentBox: Final } = resolveReferences();

		const { queries } = await userChangeQueries(Initial, Final);

		expect(queries[0]).to.not.be.undefined;
		const tempTableName = getTempTableName(queries[0]);
		expect(tempTableName).to.not.be.undefined;

		expect(queries).to.deep.equal([
			`CREATE TABLE \"${tempTableName}\" (_id INTEGER PRIMARY KEY, \"to\" integer NOT NULL, \"toName\" text NOT NULL, \"subject\" text NOT NULL, \"body\" text NOT NULL)`,
			`INSERT INTO \"${tempTableName}\" (\"_id\", \"to\", \"toName\", \"subject\", \"body\") SELECT \"_id\", \"to\", \"toName\", \"subject\", \"body\" FROM \"User\"`,
			'DROP TABLE "User"',
			`ALTER TABLE \"${tempTableName}\" RENAME TO \"User\"`,
		]);
	});

	it('does not use ADD COLUMN when adding optional column with reference', async () => {
		const { SentBox: Initial } = resolveReferences();
		const { SentBox: Final } = resolveReferences({
			SentBox: defineCollection({
				columns: {
					...BaseSentBox.columns,
					from: column.number({ references: () => BaseUser.columns.id, optional: true }),
				},
			}),
		});

		const { queries } = await userChangeQueries(Initial, Final);
		expect(queries[0]).to.not.be.undefined;
		const tempTableName = getTempTableName(queries[0]);

		expect(queries).to.deep.equal([
			`CREATE TABLE \"${tempTableName}\" (_id INTEGER PRIMARY KEY, \"to\" integer NOT NULL, \"toName\" text NOT NULL, \"subject\" text NOT NULL, \"body\" text NOT NULL, \"from\" integer REFERENCES \"User\" (\"id\"))`,
			`INSERT INTO \"${tempTableName}\" (\"_id\", \"to\", \"toName\", \"subject\", \"body\") SELECT \"_id\", \"to\", \"toName\", \"subject\", \"body\" FROM \"User\"`,
			'DROP TABLE "User"',
			`ALTER TABLE \"${tempTableName}\" RENAME TO \"User\"`,
		]);
	});

	it('adds and updates foreign key with lossless table recreate', async () => {
		const { SentBox: InitialWithoutFK } = resolveReferences();
		const { SentBox: InitialWithDifferentFK } = resolveReferences({
			SentBox: defineCollection({
				...BaseSentBox,
				foreignKeys: [{ columns: ['to'], references: () => [BaseUser.columns.id] }],
			}),
		});
		const { SentBox: Final } = resolveReferences({
			SentBox: defineCollection({
				...BaseSentBox,
				foreignKeys: [
					{
						columns: ['to', 'toName'],
						references: () => [BaseUser.columns.id, BaseUser.columns.name],
					},
				],
			}),
		});

		const expected = (tempTableName) => [
			`CREATE TABLE \"${tempTableName}\" (_id INTEGER PRIMARY KEY, \"to\" integer NOT NULL, \"toName\" text NOT NULL, \"subject\" text NOT NULL, \"body\" text NOT NULL, FOREIGN KEY (\"to\", \"toName\") REFERENCES \"User\"(\"id\", \"name\"))`,
			`INSERT INTO \"${tempTableName}\" (\"_id\", \"to\", \"toName\", \"subject\", \"body\") SELECT \"_id\", \"to\", \"toName\", \"subject\", \"body\" FROM \"User\"`,
			'DROP TABLE "User"',
			`ALTER TABLE \"${tempTableName}\" RENAME TO \"User\"`,
		];

		const addedForeignKey = await userChangeQueries(InitialWithoutFK, Final);
		const updatedForeignKey = await userChangeQueries(InitialWithDifferentFK, Final);

		expect(addedForeignKey.queries[0]).to.not.be.undefined;
		expect(updatedForeignKey.queries[0]).to.not.be.undefined;

		expect(addedForeignKey.queries).to.deep.equal(
			expected(getTempTableName(addedForeignKey.queries[0]))
		);

		expect(updatedForeignKey.queries).to.deep.equal(
			expected(getTempTableName(updatedForeignKey.queries[0]))
		);
	});
});

/** @param {string | undefined} query */
function getTempTableName(query) {
	return query.match(/User_([a-z0-9]+)/)?.[0];
}
