"use strict";

const mongodb = require('mongodb');
const sql = require('mssql');
const E = require('linq');

const config = require("./config.js");

//
// Replicate an entire SQL table to MongoDB.
//
async function replicateTable (tableName, primaryKeyField, targetDb, sqlPool) {

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

    const bulkRecordInsert = E.from(tableResult.recordset)
        .select(row => {
            row._id = row[primaryKeyField];
            return {
                updateOne: {
                    filter: { _id: row._id },
                    update: row,
                    upsert: true,                    
                },
            }            
        })
        .toArray();

    await collection.bulkWrite(bulkRecordInsert);
};

async function main () {

    const mongoClient = await mongodb.MongoClient.connect(config.mongoConnectionString);
    const targetDb = mongoClient.db(config.targetDatabaseName);
    
    const sqlPool = await sql.connect(config.sqlConnectionString);
    const tablesResult = await sqlPool.request().query(`SELECT * FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_TYPE='BASE TABLE'`);

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

    const tableNames = E.from(tablesResult.recordset)
        .select(row => row.TABLE_NAME)
        .distinct()
        .toArray();

    console.log("Replicating SQL tables " + tableNames.join(', '));
    console.log("It's time for a coffee or three.");

    for (const tableName of tableNames) {
        await replicateTable(tableName, primaryKeyMap[tableName], targetDb, sqlPool);    
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

