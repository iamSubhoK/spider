let Parser = require("./parser");
let Network = require("./network");
let {logger} = require("./library/logger");
let db = require("./models");

let Op = db.Sequelize.Op;

/**
 * The conductor is the one controlling the spidering
 * through the web. Therefor it needs to access the network
 * module and the models/database.
 */
class Conductor {
    /**
     * Initialize the conductor and start the scrape
     * @constructor
     * @param {string[]} startUrls - List of init URL, which serve as
     *                               startpoint for the scraper
     * @param {number} depth - Cutoff value for the number of hops we should
     *                         take, starting from either the database or the
     *                         startUrls.
     * @param {number} torPort - Port to use for Tor proxy.
     */
    constructor(startUrls, depth, torPort) {
        // Startup message
        logger.info("Conductor now takes over control");
        // By making a set, we make sure we do unify
        // input, in order to do no more requests than we need
        this.startUrls = startUrls;

        this.depth = depth;

        // Parser init
        this.parser = new Parser();

        // Initialization of later used variables
        this.offsetForDbRequest = 0;
        this.limitForDbRequest = Network.MAX_SLOTS;
        // This array should never exceed the limitForDbRequest size
        this.cachedDbResults = [];

        /**
         * Initialize the tor client, then start the spidering
         */
        const run = async () => {
            // Synchronize the db model
            await db.sequelize.sync();

            // Create a network instance
            this.network = await Network.build(
                torPort
            );

            // Now inserting the start urls into the database with scrape
            // timestamp=0, so they will be scraped first (with other, not yet
            // scraped data).
            // Note that we exect a csv. We then check every cell if it contains
            // a .onion url, therefor we use two nested loops.
            for (let lineOfUrls of this.startUrls) {
                for (let stringToMatch of lineOfUrls) {
                    let matchedUrls = this.parser.extractOnionURI(
                        stringToMatch
                    );
                    for (let matchedUrl of matchedUrls) {
                        let path = matchedUrl[5] || "/";
                        let baseUrl = matchedUrl[4].toLowerCase();
                        // Note: Without the await, we will get failing commits
                        // possibly we overload the database (For large numbers
                        // of initial urls)
                        // Short term: not an issue, finished in about 5 min
                        // Long term solution: Use Bulk inserts
                        await this.insertUriIntoDB(
                            baseUrl, /* baseUrl */
                            path, /* path */
                            0 /* lastScraped */
                        ).catch((err) =>{
                            logger.error(
                                "An error occured while inserting " + baseUrl +
                                "/" + path + ": " + err.toString()
                            );
                            logger.error(err.stack);
                        });
                    }
                }
            }
            // Matched url will be a list of array, where each array has the
            // following properties:
            // group0: The whole url
            // group1: http or https
            // group2: indicates whether http or https (by s) was used
            // group3: Would match any www.
            // group4: Base url
            // group5: Path

            // Now we can start the spidering
            await this.runScraper();
            this.network.startNetwork();
        };
        run().catch((ex) => {
            logger.error(
                "Caught exception while initializing start URLs" + ex.message
            );
        });
    }

    /**
     * Controls on run of the scraper. This includes storing found urls on the
     * DB and sending events to the network module to receive more data.
     */
    async runScraper() {
        // Optimization: Cache from database, then pop of
        let [dbResults, initDataAvailable] = await this.getEntriesFromDb();

        if (!initDataAvailable) {
            logger.info("No initial data available to start the scraped.");
            logger.info(
                "If you need to run on previous data, please contact" +
                "the developer. This feature is not yet implemented."
            );
            logger.info(
                "If you have initial data, please specify it on" +
                "the command line (as a csv file)."
            );
            process.exit(0);
        }

        this.cachedDbResults.concat(dbResults);

        this.network.on(
            // This is called everytime a network slot is available
            // ==> Go, get data, then network.get and finally reinsert it
            // into the database. Eventually we'll do a bulk get/insert to
            // reduce DB latency in the long run
            Network.NETWORK_READY,
            async () => {
                if (this.cachedDbResults.length == 0) {
                    let [dbResults, moreData] = await this.getEntriesFromDb();
                    this.cachedDbResults = this.cachedDbResults.concat(
                        dbResults
                    );
                    if (!moreData) {
                        this.network.freeUpSlot();
                        return;
                    }
                }

                // We want to preserve order, therefor using shift
                /** @type {DbResult} */
                let dbResult = this.cachedDbResults.shift();

                /** @type {network.NetworkHandlerResponse} */
                let networkResponse = await this.network.get(
                    dbResult.url,
                    dbResult.path
                );

                let successful = networkResponse.statusCode == 200;
                // We need to await this before proceeding to prevent getting
                // already scraped entries in the next step
                let [, pathId] = await this.insertUriIntoDB(
                    networkResponse.url,
                    networkResponse.path,
                    networkResponse.timestamp,
                    successful
                );
                await this.insertBodyIntoDB(
                    pathId,
                    networkResponse.body || "[MISSING]",
                    networkResponse.mimeType || "[MIISING]",
                    networkResponse.timestamp,
                    successful
                );
                // Inserting link
            }
        );

        // We now initialize the process by getting the first URLs from the
        // database and sending it over to the network. For now, we start
        // with never scraped data. Later we may use a configuranle time delta
    }

    /**
     * Insert the URI into the database
     * @param {string} baseUrl - The base url to be inserted
     * @param {string} path - The path of the uir to be inserted
     * @param {number} lastScraped - Contains a unix timestamp (ms), which
     *                               describes, when the uri was fetched last.
     * @param {boolean} successful=true - Indicates whether the fetch
     *                                      was successful
     * @return {UUIDV4[]} Returns the IDs of the inserted values
     *                           Those are always sorted as follows:
     *                           [baseUrlId, pathId, contentId, linkId]
     */
    async insertUriIntoDB(
        baseUrl,
        path,
        lastScraped,
        successful=true
    ) {
        let lastSuccessful = lastScraped;
        let [baseUrlEntry] = await db.baseUrl.findOrCreate({
            where: {
                baseUrl: baseUrl,
            },
            defaults: {
                baseUrl: baseUrl,
            },
        });
        let [pathEntry, created] = await db.path.findOrCreate({
            where: {
                baseUrlBaseUrlId: baseUrlEntry.baseUrlId,
                path: path,
            },
            defaults: {
                lastScrapedTimestamp: lastScraped,
                lastSuccessfulTimestamp: lastSuccessful,
                path: path,
                baseUrlBaseUrlId: baseUrlEntry.baseUrlId,
            },
        });
        // Add check for modification timestamp to ensure
        // We need to await the completion of the task here to prevent getting
        // not yet read data in the next step
        if (successful && !created) {
            await db.path.update({
                lastSuccessfulTimestamp: lastSuccessful,
                lastScrapedTimestamp: lastScraped,
            }, {
                where: {
                    baseUrlBaseUrlId: baseUrlEntry.baseUrlId,
                    path: path,
                },
            });
        } else if (!created) {
            await db.path.update({
                lastScrapedTimestamp: lastScraped,
            }, {
                where: {
                    baseUrlBaseUrlId: baseUrlEntry.baseUrlId,
                    path: path,
                },
            });
        }
        return [baseUrlEntry.baseUrlId, pathEntry.pathId, null, null];
    }

    /**
     * Inserts the body of a message as on content entry into the database.
     * This function assumes that the data is already filtered and sanitized.
     * @param {UUIDV4} pathId - ID of the corresponding path entry.
     * @param {string} body - A JSON or HTML String containing the body.
     * @param {string} mimeType - A string containing the indentifier for the
     *                            mime type of the response.
     * @param {number} timestamp - A timestamp in ms, indicating when the data
     *                             was fetched.
     * @param {boolean} successful=true - Indicates whether the download was
     *                               successful or not.
     * @return {object} Returns the created content entry.
     */
    async insertBodyIntoDB(
        pathId,
        body,
        mimeType,
        timestamp,
        successful=true
    ) {
        return await db.path.create({
            defaults: {
                scrapeTimestamp: timestamp,
                success: successful,
                contentType: mimeType,
                content: body,
                pathPathId: pathId,
            },
        });
    }

    /**
     * @typedef DbResult
     * @type {object}
     * @property {!string} url - The base url
     * @property {!string} path - The path of the entry
     * @property {?string} content - If available or requested, it can contain
     *                               the content of the entry
     * @property {?UUIDV4[]} link - A list of length 2 with two UUIDv4 within,
     *                             which describes a link between two documents
     */

    /**
     * Retrieve entries from the database that are older or as old as the passed
     * dateTime param.
     * @param {number} dateTime=0 - Specify the dateTime from which the newest
     *                             entry should be. The default will only
     *                             retrieve not yet scraped entries.
     * @param {number} limit=100 - Specify how many entries the function
     *                          should return. This is seen as an upper bound.
     *                          If no more matching entries are available, only
     *                          the remainder will be returned.
     * @param {number} offset=0 - Set if you have already received a certain
     *                           amount of data. This way one can gather all
     *                           entries of a certain timestamp or older.
     * @return {Array.<DbResult|boolean>} The DbResult contains the results
     *                      returned by the Database.
     *                      The boolean indicates whether more data is available
     *                      as of now.
     *                      Note: this can change, when the network fetches
     *                      new data. If both, network and DB do not have
     *                      anything pending, we can conclude that we have
     *                      finished and exit.
     */
    async getEntriesFromDb({
        dateTime=0,
        limit=this.limitForDbRequest,
        offset=this.offsetForDbRequest,
    } = {}) {
        if (limit == 0) {
            return [[], false];
        }
        let dbResults = [];
        let paths = await db.path.findAll({
            where: {
                lastScrapedTimestamp: {
                    [Op.lte]: dateTime,
                },
            },
            order: [
                ["createdAt", "ASC"],
            ],
            limit: limit,
            offset: offset,
        });
        for (let path of paths) {
            let dbResult = {
                "path": path.path,
                "url": null,
                "content": null,
                "link": null,
            };
            dbResult["url"] = await path.getBaseUrl();
            dbResults.push(dbResult);
        }
        this.offsetForDbRequest += paths.length;
        // We do not reset the offset counter yet, even if we did not find any
        // new data, since we do not know whether new data will arrive from the
        // network moduel. This is left to decide to the controller.
        let moreData = dbResults.length != 0;
        return [dbResults, moreData];
    }
}


module.exports = Conductor;
