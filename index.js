"use strict";

const mongodb = require('mongodb');
const sql = require('mssql');
const E = require('linq');

const config = require("./config.js");

//
// Replicate an entire SQL table to MongoDB.
//
async function replicateTable (tableName, primaryKeyField, targetDb, sqlPool, config) {

    console.log("Replicating " + tableName + " with primary key " + primaryKeyField);

    const collection = targetDb.collection(tableName);
    
    const query = "select * from [" + tableName + "]";
    console.log("Executing query: " + query);
    const tableResult = await sqlPool.request().query(query);

    console.log("Got " + tableResult.recordset.length + " records from table " + tableName);

    if (tableResult.recordset.length === 0) {
        console.log('No records to transfer.');
        return;
    }

    const primaryKeyRemap = [];

    const bulkRecordInsert = E.from(tableResult.recordset)
        .select(row => {
            if (config.remapKeys) {
                row._id = new mongodb.ObjectID(); // Allocate a new MongoDB id.
                primaryKeyRemap.push({ // Create a remap table so we can fixup foreign keys.
                    new: row._id,
                    _id: row[primaryKeyField]
                });
            }
            else {
                row._id = row[primaryKeyField]
            }
            delete row[primaryKeyField];    

            return {
                insertOne: {
                    document: row
                },
            }            
        })
        .toArray();

    await collection.bulkWrite(bulkRecordInsert);

    if (config.remapKeys) {
        const primaryKeyRemapCollection = targetDb.collection(tableName + '-pkremap');
        const primaryKeyRemapInsert = E.from(primaryKeyRemap)
            .select(row => {
                return {
                    insertOne: {
                        document: row
                    },
                }            
            })
            .toArray();
    
        await primaryKeyRemapCollection.bulkWrite(primaryKeyRemapInsert);    
    }
};

//
// Remap foreign keys for a MongoBD collection
//
async function remapForeignKeys (tableName, foreignKeysMap, targetDb, sqlPool) {

    if (!foreignKeysMap) {
        console.log(tableName + " has no foreign keys.");        
        return;
    }

    const foreignKeys = Object.keys(foreignKeysMap);
    if (foreignKeys.length ==- 0) {
        console.log(tableName + " has no foreign keys.");
        return;
    }

    console.log("Remapping foreign keys for " + tableName);
    
    const thisCollection = targetDb.collection(tableName);
    const records = await thisCollection.find().toArray();
    console.log("Updating " + records.length + " records.");

    for (const record of records) {
        const foreignKeyUpdates = {};
        let updatesMade = false;

        for (const foreignKey of foreignKeys) {
            if (!record[foreignKey]) {
                // No value.
                continue;
            }
            const otherTableName = foreignKeysMap[foreignKey].table;
            const otherTableRemap = targetDb.collection(otherTableName + '-pkremap');
            const remap = await otherTableRemap.findOne({ _id: record[foreignKey] });
            foreignKeyUpdates[foreignKey] = remap.new;
            updatesMade = true;
        }

        if (!updatesMade) {
            continue;
        }

        thisCollection.update({ _id: record._id }, { $set: foreignKeyUpdates });
    }
}

async function main () {

    const mongoClient = await mongodb.MongoClient.connect(config.mongoConnectionString);
    const targetDb = mongoClient.db(config.targetDatabaseName);
    
    const sqlPool = await sql.connect(config.sqlConnectionString);

    const primaryKeysQuery = "SELECT A.TABLE_NAME, A.CONSTRAINT_NAME, B.COLUMN_NAME\n" +
        "FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS A, INFORMATION_SCHEMA.CONSTRAINT_COLUMN_USAGE B\n" +
        "WHERE CONSTRAINT_TYPE = 'PRIMARY KEY' AND A.CONSTRAINT_NAME = B.CONSTRAINT_NAME\n" +
        "ORDER BY A.TABLE_NAME";
    const primaryKeysResult = await sqlPool.request().query(primaryKeysQuery);
    const primaryKeyMap = E.from(primaryKeysResult.recordset)
        .toObject(
            row => row.TABLE_NAME,
            row => row.COLUMN_NAME
        );

    const primaryKeysCollection = targetDb.collection("primaryKeys");
    await primaryKeysCollection.insertMany(primaryKeysResult.recordset);

    const tablesResult = await sqlPool.request().query(`SELECT * FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_TYPE='BASE TABLE'`);
    const tableNames = E.from(tablesResult.recordset)
        .select(row => row.TABLE_NAME)
        .where(tableName => config.skip.indexOf(tableName) === -1)
        .distinct()
        .toArray();

    console.log("Replicating SQL tables " + tableNames.join(', '));
    console.log("It's time for a coffee or three.");

    for (const tableName of tableNames) {
        await replicateTable(tableName, primaryKeyMap[tableName], targetDb, sqlPool, config);    
    }

    if (config.remapKeys) {
        const foreignKeysQuery = "SELECT K_Table = FK.TABLE_NAME, FK_Column = CU.COLUMN_NAME, PK_Table = PK.TABLE_NAME, PK_Column = PT.COLUMN_NAME, Constraint_Name = C.CONSTRAINT_NAME\n" +
            "FROM INFORMATION_SCHEMA.REFERENTIAL_CONSTRAINTS C\n" +
            "INNER JOIN INFORMATION_SCHEMA.TABLE_CONSTRAINTS FK ON C.CONSTRAINT_NAME = FK.CONSTRAINT_NAME\n" +
            "INNER JOIN INFORMATION_SCHEMA.TABLE_CONSTRAINTS PK ON C.UNIQUE_CONSTRAINT_NAME = PK.CONSTRAINT_NAME\n" +
            "INNER JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE CU ON C.CONSTRAINT_NAME = CU.CONSTRAINT_NAME\n" +
            "INNER JOIN (\n" +
            "SELECT i1.TABLE_NAME, i2.COLUMN_NAME\n" +
            "FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS i1\n" +
            "INNER JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE i2 ON i1.CONSTRAINT_NAME = i2.CONSTRAINT_NAME\n" +
            "WHERE i1.CONSTRAINT_TYPE = 'PRIMARY KEY'\n" +
            ") PT ON PT.TABLE_NAME = PK.TABLE_NAME";
        const foreignKeysResult = await sqlPool.request().query(foreignKeysQuery);
        const foreignKeyMap = E.from(foreignKeysResult.recordset)
            .groupBy(row => row.K_Table)
            .select(group => {
                return {
                    table: group.key(),
                    foreignKeys: E.from(group.getSource())
                        .toObject(
                            row => row.FK_Column,
                            row => ({
                                table: row.PK_Table,
                                column: row.PK_Column
                            })
                        )
                }
            })
            .toObject(
                row => row.table,
                row => row.foreignKeys
            );

        const foreignKeysCollection = targetDb.collection("foreignKeys");
        await foreignKeysCollection.insertMany(foreignKeysResult.recordset);        

        for (const tableName of tableNames) {
            await remapForeignKeys(tableName, foreignKeyMap[tableName], targetDb, sqlPool);
        }
    }

    await sqlPool.close();
    await mongoClient.close();
}

main()
    .then(() => {
        console.log('Done');
    })
    .catch(err => {
        console.error("Database replication errored out.");
        console.error(err);
    });

