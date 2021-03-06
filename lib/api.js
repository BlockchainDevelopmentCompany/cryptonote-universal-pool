var fs = require('fs');
var http = require('http');

var https = require('https');    
var url = require("url");
var zlib = require('zlib');

var async = require('async');

var apiInterfaces = require('./apiInterfaces.js')(config.daemon, config.wallet);
var charts = require('./charts.js');
var authSid = Math.round(Math.random() * 10000000000) + '' + Math.round(Math.random() * 10000000000);

var logSystem = 'api';
require('./exceptionWriter.js')(logSystem);

var redisCommands = [
    ['zremrangebyscore', config.coin + ':hashrate', '-inf', ''],
    ['zrange', config.coin + ':hashrate', 0, -1],
    ['hgetall', config.coin + ':stats'],
    ['zrange', config.coin + ':blocks:candidates', 0, -1, 'WITHSCORES'],
    ['zrevrange', config.coin + ':blocks:matured', 0, config.api.blocks - 1, 'WITHSCORES'],
    ['hgetall', config.coin + ':shares:roundCurrent'],
    ['hgetall', config.coin + ':stats'],
    ['zcard', config.coin + ':blocks:matured'],
    ['zrevrange', config.coin + ':payments:all', 0, config.api.payments - 1, 'WITHSCORES'],
    ['zcard', config.coin + ':payments:all'],
    ['keys', config.coin + ':payments:*'],
	['zremrangebyscore', config.coin + ':donationHashrate', '-inf', ''],
    ['zrange', config.coin + ':donationHashrate', 0, -1]
];

var currentStats = "";
var currentStatsCompressed = "";

var minerStats = {};
var donationStats = {};
var minersHashrate = {};
var donationsHashrate = {};
var liveConnections = {};
var addressConnections = {};



function collectStats(){

    var startTime = Date.now();
    var redisFinished;
    var daemonFinished;

    var windowTime = (((Date.now() / 1000) - config.api.hashrateWindow) | 0).toString();
    redisCommands[0][3] = '(' + windowTime;
	redisCommands[11][3] = '(' + windowTime;

    async.parallel({
        pool: function(callback){
            redisClient.multi(redisCommands).exec(function(error, replies){

                redisFinished = Date.now();
                var dateNowSeconds = Date.now() / 1000 | 0;

                if (error){
                    log('error', logSystem, 'Error getting redis data %j', [error]);
                    callback(true);
                    return;
                }

                var data = {
                    stats: replies[2],
                    blocks: replies[3].concat(replies[4]),
                    totalBlocks: parseInt(replies[7]) + (replies[3].length / 2),
                    payments: replies[8],
                    totalPayments: parseInt(replies[9]),
                    totalMinersPaid: replies[10].length - 1
                };

                var hashrates = replies[1];

                minerStats = {};
                minersHashrate = {};
		donationStats = {};
		donationsHashrate = {};

                for (var i = 0; i < hashrates.length; i++){
                    var hashParts = hashrates[i].split(':');
                    if (hashParts.length == 4) {
                        hashParts[1] = [hashParts[1], hashParts[2]].join(':');
                    }
                    minersHashrate[hashParts[1]] = (minersHashrate[hashParts[1]] || 0) + parseInt(hashParts[0]);
                }
				
				var donationHashrates = replies[12];
				
				for (var i = 0; i < donationHashrates.length; i++){
                    var donationHashParts = donationHashrates[i].split(':');
                    donationsHashrate[donationHashParts[1]] = (donationsHashrate[donationHashParts[1]] || 0) + parseInt(donationHashParts[0]);
                }
				
                var totalShares = 0;

                for (var miner in minersHashrate){
                    var shares = minersHashrate[miner];
                    totalShares += shares;
                    minersHashrate[miner] = Math.round(shares / config.api.hashrateWindow);
                    minerStats[miner] = getReadableHashRateString(minersHashrate[miner]);
                }
				
				var totalDonationShares = 0;
				
				for (var miner in donationsHashrate){
                    var donationShares = donationsHashrate[miner];
                    totalDonationShares += donationShares;
                    donationsHashrate[miner] = Math.round(donationShares / config.api.hashrateWindow);
                    donationStats[miner] = getReadableHashRateString(donationsHashrate[miner]);
                }

                data.miners = Object.keys(minerStats).length;
				data.donations = Object.keys(donationStats).length;

                data.hashrate = Math.round(totalShares / config.api.hashrateWindow);
				data.donationHashrate = Math.round(totalDonationShares / config.api.hashrateWindow);

                data.roundHashes = 0;

                if (replies[5]){
                    for (var miner in replies[5]){
                        if (config.poolServer.slushMining.enabled) { 
                            data.roundHashes += parseInt(replies[5][miner]) / Math.pow(Math.E, ((data.lastBlockFound - dateNowSeconds) / config.poolServer.slushMining.weight));
                        }
                        else
                        {
                            data.roundHashes += parseInt(replies[5][miner]);
                        }
                    }
                }
                
                if (replies[6]) {
                    data.lastBlockFound = replies[6].lastBlockFound;
                }

                callback(null, data);
            });
        },
        network: function(callback){
            apiInterfaces.rpcDaemon('getlastblockheader', {}, function(error, reply){
                daemonFinished = Date.now();
                if (error){
                    log('error', logSystem, 'Error getting daemon data %j', [error]);
                    callback(true);
                    return;
                }
                var blockHeader = reply.block_header;
                callback(null, {
                    difficulty: blockHeader.difficulty,
                    height: blockHeader.height,
                    timestamp: blockHeader.timestamp,
                    reward: blockHeader.reward,
                    hash:  blockHeader.hash
                });
            });
        },
        config: function(callback){
            callback(null, {
                ports: getPublicPorts(config.poolServer.ports),
                hashrateWindow: config.api.hashrateWindow,
                fee: config.blockUnlocker.poolFee,
                coin: config.coin,
                coinUnits: config.coinUnits,
                coinDifficultyTarget: config.coinDifficultyTarget,
                symbol: config.symbol,
                depth: config.blockUnlocker.depth,
                donation: donations,
                version: version,
                minPaymentThreshold: config.payments.minPayment,
                denominationUnit: config.payments.denomination
            });
        },
        charts: charts.getPoolChartsData
    }, function(error, results){

        log('info', logSystem, 'Stat collection finished: %d ms redis, %d ms daemon', [redisFinished - startTime, daemonFinished - startTime]);

        if (error){
            log('error', logSystem, 'Error collecting all stats');
        }
        else{
            currentStats = JSON.stringify(results);
            zlib.deflateRaw(currentStats, function(error, result){
                currentStatsCompressed = result;
                broadcastLiveStats();
            });

        }

        setTimeout(collectStats, config.api.updateInterval * 1000);
    });

}

function getPublicPorts(ports){
    return ports.filter(function(port) {
        return !port.hidden;
    });
}

function getReadableHashRateString(hashrate){
    var i = 0;
    var byteUnits = [' H', ' KH', ' MH', ' GH', ' TH', ' PH' ];
    while (hashrate > 1000){
        hashrate = hashrate / 1000;
        i++;
    }
    return hashrate.toFixed(2) + byteUnits[i];
}

function broadcastLiveStats(){

    log('info', logSystem, 'Broadcasting to %d visitors and %d address lookups', [Object.keys(liveConnections).length, Object.keys(addressConnections).length]);

    for (var uid in liveConnections){
        var res = liveConnections[uid];
        res.end(currentStatsCompressed);
    }

    var redisCommands = [];
    for (var address in addressConnections){
        var payment_id
        var simpleaddress;
        checkaddress(address, function(error, newaddress){
            if (error)
                {
                    response.end(JSON.stringify({error: 'not found'}));
                    return;
                }
            if (address.split(':').length == 2) {
                simpleaddress = newaddress;
                payment_id = address.split(':')[1];
                address = [simpleaddress, payment_id].join(':');
            }
            else
            {
                address = newaddress;
            }
        });
        redisCommands.push(['hgetall', config.coin + ':workers:' + address]);
        redisCommands.push(['zrevrange', config.coin + ':payments:' + simpleaddress, 0, config.api.payments - 1, 'WITHSCORES']);
    }
    redisClient.multi(redisCommands).exec(function(error, replies){

        var addresses = Object.keys(addressConnections);

        for (var i = 0; i < addresses.length; i++){
            var offset = i * 2;
            var address = addresses[i];
            var stats = replies[offset];
            var res = addressConnections[address];
            if (!stats){
                res.end(JSON.stringify({error: "not found"}));
                return;
            }

            
            checkaddress(address, function(error, newaddress){
                if (error)
                {
                    response.end(JSON.stringify({error: 'not found'}));
                    return;
                }

                if (address.split(':').length == 2) {
                    payment_id = address.split(':')[1];
                    address = [newaddress, payment_id].join(':');
                }
                else {
                    address = newaddress;
                }
                var payments = replies[offset + 1];
                var request_has_paymentid = address.split(':').length >1;
                var i = payments.length;
                while (i--)
                {
                    var plist = payments[i];
                    // list item has multiple elements
                    if(plist && plist.indexOf(':') > -1)
                    {
                        plist = plist.split(':');
                        var list_item_has_paymentid = plist[4];
                        if(list_item_has_paymentid)
                        {
                            if(request_has_paymentid)
                            {
                                if (plist[4] !== payment_id) {
                                  payments.splice(i,2);
                                }
                            }
                            else
                            {
                                payments.splice(i,2);
                            }
                        }
                        else
                        {
                            if(request_has_paymentid)
                            {
                                payments.splice(i,2);
                            }
                        }
                    }
                }
                stats.hashrate = minerStats[address];
                stats.donationHashrate = donationStats[address];
                res.end(JSON.stringify({stats: stats, payments: replies[offset + 1]}));
            });
        }
    });
}
function randomValueHex (len) {
	var crypto = require('crypto');
    return crypto.randomBytes(Math.ceil(len/2))
        .toString('hex') // convert to hexadecimal format
        .slice(0,len);   // return required number of characters
}


function saltedSha256(strData)
{
	var crypto = require('crypto');
	return crypto
		   .createHash('sha256')
		   .update(config.purchases.salt + strData, 'utf8')
		   .digest('hex');
	
}

function checkaddress(address, callback)
{
    var	myerror = false;
    if (address.split(':').length == 2) {
        address = address.split(':')[0];
    }
    if(address.indexOf('%40') === 0)
            address = address.substr(4);
    

    if(address.indexOf('@') === 0)
    {
        address = address.substr(1); 
        apiInterfaces.rpcDaemon('get_alias_details', {alias: address} , function (error, result)
        {
                if(error)
                {
                        callback(error);
                        return;
                }
                if ( result.status !== "OK" )
                {
                                error = {message: 'alias invalid'};
                                callback(error);
                                return;


                }
                address = result.alias_details.address;
                callback(myerror, address);
        });
    }
    else
    {
        callback(myerror, address);
    }
	
}
function handleMinerStats(urlParts, response){
    response.writeHead(200, {
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-cache',
        'Content-Type': 'application/json',
        'Connection': 'keep-alive'
    });
    response.write('\n');
    var address = urlParts.query.address;
    var simpleaddress;
    var payment_id;

    checkaddress(address, function(error, newaddress){
        if (error)
        {
            response.end(JSON.stringify({error: 'not found'}));
            return;
        }

    if (address.split(':').length == 2) {
        simpleaddress = newaddress;
        payment_id = address.split(':')[1];
        address = [newaddress, payment_id].join(':');
    }
    else {
        simpleaddress = newaddress;
        address = newaddress;
    }
    if (urlParts.query.longpoll === 'true'){
        redisClient.exists(config.coin + ':workers:' + address, function(error, result){
            if (!result){
                response.end(JSON.stringify({error: 'not found'}));
                return;
            }
            addressConnections[address] = response;
            response.on('finish', function(){
                delete addressConnections[address];
            });
        });
    }
    else {
        redisClient.multi([
            ['hgetall', config.coin + ':workers:' + address],
            ['zrevrange', config.coin + ':payments:' + simpleaddress, 0, config.api.payments - 1, 'WITHSCORES']
        ]).exec(function(error, replies){
            if (error || !replies[0]){
                response.end(JSON.stringify({error: 'not found'}));
                return;
            }
            var stats = replies[0];
            var payments = replies[1];
            var request_has_paymentid = address.split(':').length >1;
            var i = payments.length;
            while (i--)
            {
                var plist = payments[i];
                // list item has multiple elements
                if(plist && plist.indexOf(':') > -1)
                {
                    plist = plist.split(':');
                    var list_item_has_paymentid = plist[4];
                    if(list_item_has_paymentid)
                    {
                        if(request_has_paymentid)
                        {
                            if (plist[4] !== payment_id) {
                              payments.splice(i,2);
                            }
                        }
                        else
                        {
                            payments.splice(i,2);
                        }
                    }
                    else
                    {
                        if(request_has_paymentid)
                        {
                            payments.splice(i,2);
                        }
                    }
                }
            }

            stats.hashrate = minerStats[address];
            stats.donationHashrate = donationStats[address];
            charts.getUserChartsData(address, payments, function(error, chartsData) {
                response.end(JSON.stringify({
                    stats: stats,
                    payments: payments,
                    charts: chartsData
                }));
            });
        });
    }
	});
}


function handleGetPayments(urlParts, response){
    var paymentKey = ':payments:all';

    if (urlParts.query.address)
    {
        var simpleaddress;
        var payment_id;
        var address = urlParts.query.address
        
        checkaddress(address, function(error, newaddress){
            if (error)
                {
                    response.end(JSON.stringify({error: 'not found'}));
                    return;
                }
            if (address.split(':').length == 2) {
                simpleaddress = newaddress;
                payment_id = address.split(':')[1];
                address = [simpleaddress, payment_id].join(':');
            }
            else
            {
                address = newaddress;
            }
        });
        
        paymentKey = ':payments:' + simpleaddress;
    }
    
    redisClient.zrevrangebyscore(
            config.coin + paymentKey,
            '(' + urlParts.query.time,
            '-inf',
            'WITHSCORES',
            'LIMIT',
            0,
            config.api.payments,
        function(err, result){

            var reply;

            if (err)
                reply = JSON.stringify({error: 'query failed'});
            else
            {
                var payments = result;
                var request_has_paymentid = false;
		if (urlParts.query.address && address.indexOf(':') != -1)
		{
			request_has_paymentid = address.split(':').length >1;
		}
                var i = payments.length;
                while (i--)
                {
                    var plist = payments[i];
                    // list item has multiple elements
                    if(plist && plist.indexOf(':') > -1)
                    {
                        plist = plist.split(':');
                        var list_item_has_paymentid = plist[4];
                        if(list_item_has_paymentid)
                        {
                            if(request_has_paymentid)
                            {
                                if (plist[4] !== payment_id) {
                                  payments.splice(i,2);
                                }
                            }
                            else
                            {
                                payments.splice(i,2);
                            }
                        }
                        else
                        {
                            if(request_has_paymentid)
                            {
                                payments.splice(i,2);
                            }
                        }
                    }
                }
                reply = JSON.stringify(payments);
            }
            response.writeHead("200", {
                'Access-Control-Allow-Origin': '*',
                'Cache-Control': 'no-cache',
                'Content-Type': 'application/json',
                'Content-Length': reply.length
            });
            response.end(reply);

        }
    );
}

function validateEmail(email) { 
    var re = /^(([^<>()[\]\\.,;:\s@\"]+(\.[^<>()[\]\\.,;:\s@\"]+)*)|(\".+\"))@((\[[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\])|(([a-zA-Z\-0-9]+\.)+[a-zA-Z]{2,}))$/;
    return re.test(email);
}

function handleGetPayment(urlParts, response){
	var reply;
	var cnUtil = require('cryptonote-util');
	var pattern = /^[a-z0-9]+$/;
	if(urlParts.query.alias)
	{
		if(!pattern.test(urlParts.query.alias) || urlParts.query.alias.length > 255)
		{
			reply = JSON.stringify({error: 'query failed: invalid alias'});
			response.writeHead("200", {
				'Access-Control-Allow-Origin': '*',
				'Cache-Control': 'no-cache',
				'Content-Type': 'application/json',
				'Content-Length': reply.length
			});
			response.end(reply);
			return;
		}
	}
	if(urlParts.query.email && !validateEmail(urlParts.query.email))
	{
		reply = JSON.stringify({error: 'query failed: invalid email'});
		response.writeHead("200", {
			'Access-Control-Allow-Origin': '*',
			'Cache-Control': 'no-cache',
			'Content-Type': 'application/json',
			'Content-Length': reply.length
		});
		response.end(reply);
		return;
	}
	var addressBase58Prefix = cnUtil.address_decode(new Buffer(config.poolServer.poolAddress));
	if (urlParts.query.address && addressBase58Prefix !== cnUtil.address_decode(new Buffer(urlParts.query.address)))
	{
		reply = JSON.stringify({error: 'query failed: invalid address'});
		response.writeHead("200", {
			'Access-Control-Allow-Origin': '*',
			'Cache-Control': 'no-cache',
			'Content-Type': 'application/json',
			'Content-Length': reply.length
		});
		response.end(reply);
		return;
	}
						
	checkaddress(
			'@' + urlParts.query.alias,
	function(error, address)
	{
		if (error)
			{
			redisClient.hexists(config.coin + ':aliasrequest:' + urlParts.query.alias,
					'alias',
					function(err1, result1)
					{
						var nodemailer = require('nodemailer');
						var transporter = nodemailer.createTransport({
							service: 'gmail',
							auth: {
								user: 'cncoinpayments@gmail.com',
								pass: 'myvbifrqjfirczhj'
							}
						});
						if(err1)
						{
							reply = JSON.stringify({error: 'query failed: error querying alias request'});
							response.writeHead("200", {
									'Access-Control-Allow-Origin': '*',
									'Cache-Control': 'no-cache',
									'Content-Type': 'application/json',
									'Content-Length': reply.length
								});
							response.end(reply);
							return;
						}
						if (result1 === 0)
						{
							if(urlParts.query.address && urlParts.query.alias && urlParts.query.email)
							{
							var hash = randomValueHex(12);
							var paymentid = saltedSha256(urlParts.query.alias);
							redisClient.hmset(
									config.coin + ':aliasrequest:' + urlParts.query.alias,
									'alias', urlParts.query.alias,
									'email', urlParts.query.email,
									'address', urlParts.query.address,
									'hash', hash,
									'paymentid', paymentid,
									'validated', 0,
									'paid', 0,
									function(err, result)
									{

										if (err)
										{
											reply = JSON.stringify({error: 'query failed'});
										}
										else
										{
											reply = JSON.stringify({status: 'request succeeded'});

										}
										redisClient.expire(config.coin + ':aliasrequest:' + urlParts.query.alias, 60 * 40);
										transporter.sendMail({
                                                                                        from: config.purchases.supportEmail,
											to: urlParts.query.email,
                                                                                        subject: 'cncoin.farm Alias request received',
											text: 'Thank you for your alias request.\n\
\n\
Request info:\n\
Alias: ' + urlParts.query.alias + '\n\
' + config.symbol + ' Address: ' + urlParts.query.address + '\n\
\n\
To validate your email, please copy and paste\nthe following into your browser\n\
\n\
' + config.purchases.emailUrl + '?alias=' + urlParts.query.alias + '?hash=' + hash + '#register_alias\n\
\n\
This request will expire in ' + (config.purchases.waitTime / 60) + ' minutes\n\n' +
'Once validated, you will need to send ' + config.purchases.requiredAmount + ' ' + config.symbol + ' to: ' + config.purchases.paymentAddress + '\nwith paymentid: ' + paymentid + '\n\
for example:\n\
\n\
transfer 0 ' + config.purchases.paymentAddress + ' ' + config.purchases.requiredAmount + ' ' + paymentid + ' \n\n\
\n\
\n\
Don\'t forget the payment ID at the end!\n\
\n\
Please save a copy of this email as proof of request\n\n\
\n\
and if any disputes/claims need to be made.\n\
\n\
Thank you,\n\
Clintar'
										});
										response.writeHead("200", {
											'Access-Control-Allow-Origin': '*',
											'Cache-Control': 'no-cache',
											'Content-Type': 'application/json',
											'Content-Length': reply.length
										});
										response.end(reply);
										return;
									}
							);
							}
							else
							{
								reply = JSON.stringify({error: 'request does not exist'});
								response.writeHead("200", {
											'Access-Control-Allow-Origin': '*',
											'Cache-Control': 'no-cache',
											'Content-Type': 'application/json',
											'Content-Length': reply.length
										});
										response.end(reply);
										return;
							}
						}
						else if (urlParts.query.hash || urlParts.query.checkforpayment)
						{
							redisClient.hgetall(config.coin + ':aliasrequest:' + urlParts.query.alias,
									function(err1, getallResult)
									{
										if(err1)
										{
											reply = JSON.stringify({
												status: 'request not found'
											});
											response.writeHead("200", {
												'Access-Control-Allow-Origin': '*',
												'Cache-Control': 'no-cache',
												'Content-Type': 'application/json',
												'Content-Length': reply.length
											});
											response.end(reply);
											return;
										}

										if(urlParts.query.checkforpayment )
										{
											if(getallResult.paid === '1')
											{

													reply = JSON.stringify({
															status: 'paid'
														});
											}
											else
											{
												reply = JSON.stringify({
															status: 'notpaid'
														});
											}
											response.writeHead("200", {
															'Access-Control-Allow-Origin': '*',
															'Cache-Control': 'no-cache',
															'Content-Type': 'application/json',
															'Content-Length': reply.length
														});
														response.end(reply);
														return;
										}
										if(urlParts.query.hash === getallResult.hash)
										{
											redisClient.ttl(config.coin + ':aliasrequest:' + urlParts.query.alias,
												function(err2, ttlResult) {
													if(getallResult.validated !== '1')
													{
														redisClient.hset(
															config.coin + ':aliasrequest:' + urlParts.query.alias,
															'validated', 1
															);
														redisClient.lpush(config.coin + ':aliasrequests', config.coin + ':aliasrequest:' + urlParts.query.alias);
													}

													reply = JSON.stringify({
														status: 'validated',
														alias: urlParts.query.alias,
														ttl: ttlResult
													});
													response.writeHead("200", {
														'Access-Control-Allow-Origin': '*',
														'Cache-Control': 'no-cache',
														'Content-Type': 'application/json',
														'Content-Length': reply.length
													});
													response.end(reply);
													return;
												});
										}
										else
										{
											reply = JSON.stringify({error: 'query failed: invalid hash'});
											response.writeHead("200", {
												'Access-Control-Allow-Origin': '*',
												'Cache-Control': 'no-cache',
												'Content-Type': 'application/json',
												'Content-Length': reply.length
											});
											response.end(reply);
											return;
										}
									});
						}
						else
						{
							reply = JSON.stringify({error: 'query failed: request already exists'});
							response.writeHead("200", {
								'Access-Control-Allow-Origin': '*',
								'Cache-Control': 'no-cache',
								'Content-Type': 'application/json',
								'Content-Length': reply.length
							});
							response.end(reply);
							return;
						}
					});
		}
		else
		{
			reply = JSON.stringify({error: 'query failed: alias exists'});
			response.writeHead("200", {
				'Access-Control-Allow-Origin': '*',
				'Cache-Control': 'no-cache',
				'Content-Type': 'application/json',
				'Content-Length': reply.length
			});
			response.end(reply);
		}
	});
	
	


};

function handleGetBlocks(urlParts, response){
    redisClient.zrevrangebyscore(
            config.coin + ':blocks:matured',
            '(' + urlParts.query.height,
            '-inf',
            'WITHSCORES',
            'LIMIT',
            0,
            config.api.blocks,
        function(err, result){

        var reply;

        if (err)
            reply = JSON.stringify({error: 'query failed'});
        else
            reply = JSON.stringify(result);

        response.writeHead("200", {
            'Access-Control-Allow-Origin': '*',
            'Cache-Control': 'no-cache',
            'Content-Type': 'application/json',
            'Content-Length': reply.length
        });
        response.end(reply);

    });
}

function handleGetMinersHashrate(response) {
    var reply = JSON.stringify({
        minersHashrate: minersHashrate,
		donationsHashrate: donationsHashrate
    });
    response.writeHead("200", {
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-cache',
        'Content-Type': 'application/json',
        'Content-Length': reply.length
    });
    response.end(reply);
}

function handleGetDonationsHashrate(response) {
    var reply = JSON.stringify({
		donationsHashrate: donationsHashrate
    });
    response.writeHead("200", {
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-cache',
        'Content-Type': 'application/json',
        'Content-Length': reply.length
    });
    response.end(reply);
}

function parseCookies(request) {
    var list = {},
        rc = request.headers.cookie;
    rc && rc.split(';').forEach(function(cookie) {
        var parts = cookie.split('=');
        list[parts.shift().trim()] = unescape(parts.join('='));
    });
    return list;
}

function authorize(request, response){
    if(request.connection.remoteAddress == '127.0.0.1' || request.connection.remoteAddress == '::ffff:127.0.0.1' || request.connection.remoteAddress == '::1') {
        return true;
    }

    response.setHeader('Access-Control-Allow-Origin', '*');

    var cookies = parseCookies(request);
    if(cookies.sid && cookies.sid == authSid) {
        return true;
    }

    var sentPass = url.parse(request.url, true).query.password;


    if (sentPass !== config.api.password){
        response.statusCode = 401;
        response.end('invalid password');
        return;
    }

    log('warn', logSystem, 'Admin authorized');
    response.statusCode = 200;

    var cookieExpire = new Date( new Date().getTime() + 60*60*24*1000);
    response.setHeader('Set-Cookie', 'sid=' + authSid + '; path=/; expires=' + cookieExpire.toUTCString());
    response.setHeader('Cache-Control', 'no-cache');
    response.setHeader('Content-Type', 'application/json');


    return true;
}

function handleAdminStats(response){

    async.waterfall([

        //Get worker keys & unlocked blocks
        function(callback){
            redisClient.multi([
                ['keys', config.coin + ':workers:*'],
                ['zrange', config.coin + ':blocks:matured', 0, -1]
            ]).exec(function(error, replies) {
                if (error) {
                    log('error', logSystem, 'Error trying to get admin data from redis %j', [error]);
                    callback(true);
                    return;
                }
                callback(null, replies[0], replies[1]);
            });
        },

        //Get worker balances
        function(workerKeys, blocks, callback){
            var redisCommands = workerKeys.map(function(k){
                return ['hmget', k, 'balance', 'paid'];
            });
            redisClient.multi(redisCommands).exec(function(error, replies){
                if (error){
                    log('error', logSystem, 'Error with getting balances from redis %j', [error]);
                    callback(true);
                    return;
                }

                callback(null, replies, blocks);
            });
        },
        function(workerData, blocks, callback){
            var stats = {
                totalOwed: 0,
                totalPaid: 0,
                totalRevenue: 0,
                totalDiff: 0,
                totalShares: 0,
                blocksOrphaned: 0,
                blocksUnlocked: 0,
                totalWorkers: 0
            };

            for (var i = 0; i < workerData.length; i++){
                stats.totalOwed += parseInt(workerData[i][0]) || 0;
                stats.totalPaid += parseInt(workerData[i][1]) || 0;
                stats.totalWorkers++;
            }

            for (var i = 0; i < blocks.length; i++){
                var block = blocks[i].split(':');
                if (block[5]) {
                    stats.blocksUnlocked++;
                    stats.totalDiff += parseInt(block[2]);
                    stats.totalShares += parseInt(block[3]);
                    stats.totalRevenue += parseInt(block[5]);
                }
                else{
                    stats.blocksOrphaned++;
                }
            }
            callback(null, stats);
        }
    ], function(error, stats){
            if (error){
                response.end(JSON.stringify({error: 'error collecting stats'}));
                return;
            }
            response.end(JSON.stringify(stats));
        }
    );

}


function handleAdminUsers(response){
    async.waterfall([
        // get workers Redis keys
        function(callback) {
            redisClient.keys(config.coin + ':workers:*', callback);
        },
        // get workers data
        function(workerKeys, callback) {
            var redisCommands = workerKeys.map(function(k) {
                return ['hmget', k, 'balance', 'paid', 'lastShare', 'hashes'];
            });
            redisClient.multi(redisCommands).exec(function(error, redisData) {
                var workersData = {};
                var addressLength = config.poolServer.poolAddress.length;
                for(var i in redisData) {
                    var address = workerKeys[i].substr(-addressLength);
                    var data = redisData[i];
                    workersData[address] = {
                        pending: data[0],
                        paid: data[1],
                        lastShare: data[2],
                        hashes: data[3],
                        hashrate: minersHashrate[address] ? minersHashrate[address] : 0
                    };
                }
                callback(null, workersData);
            });
        }
    ], function(error, workersData) {
            if(error) {
                response.end(JSON.stringify({error: 'error collecting users stats'}));
                return;
            }
            response.end(JSON.stringify(workersData));
        }
    );
}


function handleAdminMonitoring(response) {
    response.writeHead("200", {
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-cache',
        'Content-Type': 'application/json'
    });
    async.parallel({
        monitoring: getMonitoringData,
        logs: getLogFiles
    }, function(error, result) {
        response.end(JSON.stringify(result));
    });
}

function handleAdminLog(urlParts, response){
    var file = urlParts.query.file;
    var filePath = config.logging.files.directory + '/' + file;
    if(!file.match(/^\w+\.log$/)) {
        response.end('wrong log file');
    }
    response.writeHead(200, {
        'Content-Type': 'text/plain',
        'Cache-Control': 'no-cache',
        'Content-Length': fs.statSync(filePath).size
    });
    fs.createReadStream(filePath).pipe(response);
}


function startRpcMonitoring(rpc, module, method, interval) {
    setInterval(function() {
        rpc(method, {}, function(error, response) {
            var stat = {
                lastCheck: new Date() / 1000 | 0,
                lastStatus: error ? 'fail' : 'ok',
                lastResponse: JSON.stringify(error ? error : response)
            };
            if(error) {
                stat.lastFail = stat.lastCheck;
                stat.lastFailResponse = stat.lastResponse;
            }
            var key = getMonitoringDataKey(module);
            var redisCommands = [];
            for(var property in stat) {
                redisCommands.push(['hset', key, property, stat[property]]);
            }
            redisClient.multi(redisCommands).exec();
        });
    }, interval * 1000);
}

function getMonitoringDataKey(module) {
    return config.coin + ':status:' + module;
}

function initMonitoring() {
    var modulesRpc = {
        daemon: apiInterfaces.rpcDaemon,
        wallet: apiInterfaces.rpcWallet
    };
    for(var module in config.monitoring) {
        var settings = config.monitoring[module];
        if(settings.checkInterval) {
            startRpcMonitoring(modulesRpc[module], module, settings.rpcMethod, settings.checkInterval);
        }
    }
}



function getMonitoringData(callback) {
    var modules = Object.keys(config.monitoring);
    var redisCommands = [];
    for(var i in modules) {
        redisCommands.push(['hgetall', getMonitoringDataKey(modules[i])]);
    }
    redisClient.multi(redisCommands).exec(function(error, results) {
        var stats = {};
        for(var i in modules) {
            if(results[i]) {
                stats[modules[i]] = results[i];
            }
        }
        callback(error, stats);
    });
}

function getLogFiles(callback) {
    var dir = config.logging.files.directory;
    fs.readdir(dir, function(error, files) {
        var logs = {};
        for(var i in files) {
            var file = files[i];
            var stats = fs.statSync(dir + '/' + file);
            logs[file] = {
                size: stats.size,
                changed: Date.parse(stats.mtime) / 1000 | 0
            };
        }
        callback(error, logs);
    });
}
if(config.api.ssl == true)
{
    var options = {
        key: fs.readFileSync(config.api.sslkey),
        cert: fs.readFileSync(config.api.sslcert),
        ca: fs.readFileSync(config.api.sslca),
        honorCipherOrder: true
    };
        
    var server2 = https.createServer(options, function(request, response){
        

        if (request.method.toUpperCase() === "OPTIONS"){

            response.writeHead("204", "No Content", {
                "access-control-allow-origin": '*',
                "access-control-allow-methods": "GET, POST, PUT, DELETE, OPTIONS",
                "access-control-allow-headers": "content-type, accept",
                "access-control-max-age": 10, // Seconds.
                "content-length": 0,
                "Strict-Transport-Security": "max-age=604800"
            });

            return(response.end());
        }


        var urlParts = url.parse(request.url, true);

        switch(urlParts.pathname){
            case '/stats':
                var deflate = request.headers['accept-encoding'] && request.headers['accept-encoding'].indexOf('deflate') != -1;
                var reply = deflate ? currentStatsCompressed : currentStats;
                response.writeHead("200", {
                    'Access-Control-Allow-Origin': '*',
                    'Cache-Control': 'no-cache',
                    'Content-Type': 'application/json',
                    'Content-Encoding': deflate ? 'deflate' : '',
                    'Content-Length': reply.length
                });
                response.end(reply);
                break;
            case '/live_stats':
                response.writeHead(200, {
                    'Access-Control-Allow-Origin': '*',
                    'Cache-Control': 'no-cache',
                    'Content-Type': 'application/json',
                    'Content-Encoding': 'deflate',
                    'Connection': 'keep-alive'
                });
                var uid = Math.random().toString();
                liveConnections[uid] = response;
                response.on("finish", function() {
                    delete liveConnections[uid];
                });
                break;
            case '/stats_address':
                handleMinerStats(urlParts, response);
                break;
            case '/get_payments':
                handleGetPayments(urlParts, response);
                break;
            case '/get_blocks':
                handleGetBlocks(urlParts, response);
                break;
            case '/get_payment':
                handleGetPayment(urlParts, response);
                break;
            case '/admin_stats':
                if (!authorize(request, response))
                    return;
                handleAdminStats(response);
                break;
            case '/admin_monitoring':
                if(!authorize(request, response)) {
                    return;
                }
                handleAdminMonitoring(response);
                break;
            case '/admin_log':
                if(!authorize(request, response)) {
                    return;
                }
                handleAdminLog(urlParts, response);
                break;
            case '/admin_users':
                if(!authorize(request, response)) {
                    return;
                }
                handleAdminUsers(response);
                break;

            case '/miners_hashrate':
                if (!authorize(request, response))
                    return;
                handleGetMinersHashrate(response);
                break;
            case '/miners_donationHashrate':
                if (!authorize(request, response))
                    return;
                handleGetDonationsHashrate(response);
                break;
            default:
                response.writeHead(404, {
                    'Access-Control-Allow-Origin': '*'
                });
                response.end('Invalid API call');
                break;
        }
    });
}

var server = http.createServer(function(request, response){

    if (request.method.toUpperCase() === "OPTIONS"){

        response.writeHead("204", "No Content", {
            "access-control-allow-origin": '*',
            "access-control-allow-methods": "GET, POST, PUT, DELETE, OPTIONS",
            "access-control-allow-headers": "content-type, accept",
            "access-control-max-age": 10, // Seconds.
            "content-length": 0
        });

        return(response.end());
    }


    var urlParts = url.parse(request.url, true);

    switch(urlParts.pathname){
        case '/stats':
            var deflate = request.headers['accept-encoding'] && request.headers['accept-encoding'].indexOf('deflate') != -1;
            var reply = deflate ? currentStatsCompressed : currentStats;
            response.writeHead("200", {
                'Access-Control-Allow-Origin': '*',
                'Cache-Control': 'no-cache',
                'Content-Type': 'application/json',
                'Content-Encoding': deflate ? 'deflate' : '',
                'Content-Length': reply.length
            });
            response.end(reply);
            break;
        case '/live_stats':
            response.writeHead(200, {
                'Access-Control-Allow-Origin': '*',
                'Cache-Control': 'no-cache',
                'Content-Type': 'application/json',
                'Content-Encoding': 'deflate',
                'Connection': 'keep-alive'
            });
            var uid = Math.random().toString();
            liveConnections[uid] = response;
            response.on("finish", function() {
                delete liveConnections[uid];
            });
            break;
        case '/stats_address':
            handleMinerStats(urlParts, response);
            break;
        case '/get_payments':
            handleGetPayments(urlParts, response);
            break;
        case '/get_blocks':
            handleGetBlocks(urlParts, response);
            break;
        case '/get_payment':
            handleGetPayment(urlParts, response);
            break;
        case '/admin_stats':
            if (!authorize(request, response))
                return;
            handleAdminStats(response);
            break;
        case '/admin_monitoring':
            if(!authorize(request, response)) {
                return;
            }
            handleAdminMonitoring(response);
            break;
        case '/admin_log':
            if(!authorize(request, response)) {
                return;
            }
            handleAdminLog(urlParts, response);
            break;
        case '/admin_users':
            if(!authorize(request, response)) {
                return;
            }
            handleAdminUsers(response);
            break;

        case '/miners_hashrate':
            if (!authorize(request, response))
                return;
            handleGetMinersHashrate(response);
            break;
        case '/miners_donationHashrate':
            if (!authorize(request, response))
                return;
            handleGetDonationsHashrate(response);
            break;
        default:
            response.writeHead(404, {
                'Access-Control-Allow-Origin': '*'
            });
            response.end('Invalid API call');
            break;
    }
});

collectStats();
initMonitoring();

server.listen(config.api.port, function(){
    log('info', logSystem, 'API started & listening on port %d', [config.api.port]);
});
if(config.api.ssl == true)
{
    server2.listen(config.api.sslport, function(){
    log('info', logSystem, 'API started & listening on port %d', [config.api.port]);
});
}

