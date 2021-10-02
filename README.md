# sql-to-mongodb

A Node.js script to convert an SQL database to a MongoDB database.

If you like this project, please star this repo and [support my work](https://www.codecapers.com.au/about#support-my-work)

Features

- Automatically detects the primary key for each SQL table and copys it to the MongoDB _id field.
- Optionally remaps replaces and primary keys with MongoDB ObjectId's and remaps foreign keys.
- Automatically copies across types correctly (eg numbers and dates).

## Usage

### Install 

First install dependencies:

    npm install

### Setup

Edit config.js. Add the connection string for your SQL database. Modify the MongoDB connection string if necessary. Set the name of your target database in MongoDB.

### Run

    node index.js

### Wait

It might take some time to replicate!

## More!

Find more like this in my new book [Data Wrangling with JavaScript](http://bit.ly/2t2cJu2)
    
