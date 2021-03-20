// Require all the dependencies
require("dotenv").config();
const mariadb = require("mariadb");
const si = require("systeminformation");
const cron = require("node-cron");

// Create pool for database connections
const pool = mariadb.createPool({
    database: process.env.DB_DATABASE,
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    connectionLimit: 10
});

// Create data tables
async function createTables() {
    // Get a connection from pool
    let conn = await pool.getConnection();
    try {
        await conn.query(
            `CREATE TABLE IF NOT EXISTS graph (
                time double,
                cpuLoad float,
                cpuProcessCount int,
                ramUsed int,
                ramUsedPercentage float,
                swapUsed int,
                swapUsedPercentage float,
                diskReadSpeed float,
                diskWriteSpeed float,
                downloadSpeed float,
                uploadSpeed float,
                pingGoogle float,
                pingCloudflare float,
                pingDiscord float
            )`
        );
        await conn.query(
            `CREATE TABLE IF NOT EXISTS stat (
                time double,
                cpuClock float,
                cpuCores int,
                uptime double,
                ramTotal int,
                swapTotal int,
                diskSize float,
                diskReadTotal int,
                diskWriteTotal int,
                diskUsed float,
                diskUsedPercentage float,
                downloadTotal int,
                uploadTotal int
            )`
        );
        await conn.query(
            `DELETE FROM stat`
        );
        await conn.query(
            `INSERT INTO stat VALUES (NULL${",NULL".repeat(12)})`
        );
        console.log("Ensured database table existence.");
    } catch(e) {
        // Log error and quit
        console.error(e);
        process.exit(0);
    } finally {
        // Release the connection
        conn.release();
    }
}

// Create tables and save the ready state
let databaseReady = false;
createTables().then(() => databaseReady = true);

// Save data to database
async function saveData(data) {
    // Get a connection from pool
    let conn = await pool.getConnection();
    // Catch any errors
    try {
        // Try to insert values to database
        await conn.query(
            `INSERT INTO graph VALUES (?${",?".repeat(13)})`,
            [ Date.now(), ...Object.values(data.graph) ]
        );
        await conn.query(
            `UPDATE stat SET
            time = ?,
            cpuClock = ?,
            cpuCores = ?,
            uptime = ?,
            ramTotal = ?,
            swapTotal = ?,
            diskSize = ?,
            diskReadTotal = ?,
            diskWriteTotal = ?,
            diskUsed = ?,
            diskUsedPercentage = ?,
            downloadTotal = ?,
            uploadTotal = ?`,
            [ Date.now(), ...Object.values(data.stat) ]
        );
        console.log(`Saved data at ${new Date().toISOString()}`);
    } catch(e) {
        // Log and ignore
        console.error(e);
    } finally {
        // Release the connection
        conn.release();
    }
}

// Get all the data
async function getData() {
    let [
        // CPU
        { speed: cpuClock, cores: cpuCores },
        { currentLoad: cpuLoad },
        { all: cpuProcessCount },
        { uptime },
        // RAM
        { total: ramTotal, used: ramUsed, swaptotal: swapTotal, swapused: swapUsed },
        // DISK
        [ { size: diskSize, used: diskUsed, use: diskUsedPercentage } ],
        { rx: diskReadTotal, wx: diskWriteTotal, rx_sec: diskReadSpeed, wx_sec: diskWriteSpeed },
        // INTERNET
        [ { rx_bytes: downloadTotal, tx_bytes: uploadTotal, rx_sec: downloadSpeed, tx_sec: uploadSpeed } ],
        pingGoogle,
        pingCloudflare,
        pingDiscord
    ] = await Promise.all([
        // CPU
        si.cpu(),
        si.currentLoad(),
        si.processes(),
        si.time(),
        // RAM
        si.mem(),
        // DISK
        si.fsSize(),
        si.fsStats(),
        // INTERNET
        si.networkStats("eth0"),
        si.inetLatency("8.8.8.8"),
        si.inetLatency("1.1.1.1"),
        si.inetLatency("discord.com")
    ]);

    // Calculating percentages
    let ramUsedPercentage = +(ramUsed / ramTotal * 100).toFixed(1);
    let swapUsedPercentage = +(swapUsed / swapTotal * 100).toFixed(1);

    // Math to convert and round all the numbers
    let toMegaByte = Math.pow(1024, 2);
    let toGigaByte = Math.pow(1024, 3);
    let toBits = 8;
    cpuLoad = +cpuLoad.toFixed(1);
    ramTotal = Math.round(ramTotal / toMegaByte);
    ramUsed = Math.round(ramUsed / toMegaByte);
    swapTotal = Math.round(swapTotal / toMegaByte);
    swapUsed = Math.round(swapUsed / toMegaByte);
    diskSize = +(diskSize / toGigaByte).toFixed(1);
    diskUsed = +(diskUsed / toGigaByte).toFixed(1);
    diskUsedPercentage = +diskUsedPercentage.toFixed(1);
    diskReadTotal = Math.round(diskReadTotal / toGigaByte);
    diskWriteTotal = Math.round(diskWriteTotal / toGigaByte);
    diskReadSpeed = +(diskReadSpeed / toMegaByte).toFixed(1);
    diskWriteSpeed = +(diskWriteSpeed / toMegaByte).toFixed(1);
    downloadTotal = Math.round(downloadTotal / toGigaByte * toBits);
    downloadSpeed = +(downloadSpeed / toMegaByte * toBits).toFixed(1);
    uploadTotal =  Math.round(uploadTotal / toGigaByte * toBits);
    uploadSpeed = +(uploadSpeed / toMegaByte * toBits).toFixed(1);
    pingGoogle = +pingGoogle.toFixed(1);
    pingCloudflare = +pingCloudflare.toFixed(1);
    pingDiscord = +pingDiscord.toFixed(1);

    // Return the values
    // Units documented below
    return {
        // These values will be graphed and need
        // to be saved everytime
        graph: {
            // %, none
            cpuLoad, cpuProcessCount,
            // MB, %, MB, %
            ramUsed, ramUsedPercentage, swapUsed, swapUsedPercentage,
            // MB/s, MB/s
            diskReadSpeed, diskWriteSpeed,
            // Mb/s, Mb/s
            downloadSpeed, uploadSpeed,
            // ms, ms, ms
            pingGoogle, pingCloudflare, pingDiscord
        },
        // These are used for single stats
        // so only the current value is needed
        stat: {
            // Ghz, none, seconds
            cpuClock, cpuCores, uptime,
            // MB, MB
            ramTotal, swapTotal,
            // GB, GB, GB GB, %
            diskSize, diskReadTotal, diskWriteTotal, diskUsed, diskUsedPercentage,
            // Gb, Gb
            downloadTotal, uploadTotal
        }
    };
}

// Schedule saving for every 30 seconds
cron.schedule("*/30 * * * * *", async () => {
    // Return if database not ready
    if(!databaseReady) return;
    // Get the data
    let data = await getData();
    // If any value is null, just skip the round
    // Skipped rounds are better than invalid values
    if(Object.values(data.graph).concat(Object.values(data.stat)).some(v => v === null)) return;
    // Save the data
    saveData(data);
});
