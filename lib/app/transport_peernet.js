﻿/*

This file is part of Streembit application. 
Streembit is an open source project to create a real time communication system for humans and machines. 

Streembit is a free software: you can redistribute it and/or modify it under the terms of the GNU General Public License 
as published by the Free Software Foundation, either version 3.0 of the License, or (at your option) any later version.

Streembit is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty 
of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU General Public License for more details.

You should have received a copy of the GNU General Public License along with Streembit software.  
If not, see http://www.gnu.org/licenses/.
 
-------------------------------------------------------------------------------------------------------------------------
Author: Tibor Zsolt Pardi 
Copyright (C) 2016 The Streembit software development team
-------------------------------------------------------------------------------------------------------------------------

Peer to peer implementation of the Streembit network

*/

'use strict';

var async = require('async');
var kad = require("./peerutils").kad;
var upnp = require("./peerutils").upnp;
var discovery = require("./peerutils").discovery;
var logger = require('./logger');
var config = require('./config');
var Seeds = require('./seeds').default;
var ecckey = require("cryptlib");
var secrand = require('secure-random');
var createHash = require('create-hash');
var peermsg = require("peermsg");
var database = require('./database');
var auth = require('./auth');
var appevents = require("appevents");
var user = require('./user');
var appsrvc = require('./appsrvc');
var defs = require('./definitions');
var net = nwrequire("net");

function TransportPeerNet() {
    this.connected = false;
    this.bootseeds = null;
    this.address = null;
    this.port = config.appconfig.tcpport || defs.APP_PORT;
    this.account = null;
    this.public_key = null;
    this.node = null;

    this.init = function(completefn) {
        var self = this;
        try {
            logger.debug("Initializing peer Streembit client");

            async.waterfall([
                function (callback) {
                    try {
                        self.disconnect(callback);
                    }
                    catch (err) {
                        callback(err);
                    }
                },
                function (callback) {
                    try {
                        self.setUpnpPort(callback);
                    }
                    catch (err) {
                        callback(err);
                    }
                },
                function (callback) {
                    try {
                        Seeds.load(callback);
                    }
                    catch (err) {
                        callback(err);
                    }
                },
                function (seeds, callback) {                    
                    try {
                        if (!seeds || !Array.isArray(seeds) || !seeds.length) {
                            return callback("Error in populating the seed list. Please make sure the 'bootseeds' configuration is correct and a firewall doesn't block the Streembit software!");
                        }
                        self.bootseeds = seeds;
                        discovery(seeds, function (err, ipaddress) {
                            if (err) {
                                return callback(err);
                            }
                            self.address = ipaddress;
                            callback();
                        });
                    }
                    catch (err) {
                        callback(err);
                    }
                },
                function (callback) {
                    try {
                        self.initNetwork(callback);
                    }
                    catch (err) {
                        callback(err);
                    }
                }//,
                //function (callback) {
                //    // validate the network
                //    callback("Network validation failed. The client is not properly connected to the network.");
                //}
            ],
            function (err, result) {
                if (err) {
                    self.connected = false;
                    self.node = null;
                    appsrvc.node = null;
                    appsrvc.address = null;
                    appsrvc.port = null;
                    appsrvc.net_connected = false;
                    completefn(err);
                }
                else {
                    completefn();
                }
            });
        }
        catch (e) {
            completefn(e);
        }            
    }
 
    this.disconnect = function(callback) {
        var self = this;

        this.connected = false;
        this.node = null;
        appsrvc.node = null;
        appsrvc.address = null;
        appsrvc.port = null;
        appsrvc.net_connected = false;

        if (appsrvc.node && this.connected == true) {
            appsrvc.node.disconnect(function () {         
                callback();
            });
        }
        else {
            callback();
        }
    }

    this.onTransportError = function(err) {
        logger.error('KAD RPC error: %j', err);
    }
    
    this.msg_stored = function (node_id, item)  {
        if (!item || !item.key || !item.hash || !item.value) { return }

        var msgkey = user.name + "/message/";
        if (key.indexOf(msgkey) > -1 && item.recipient == user.name) {
            // create an array
            var items = [item];
            appevents.emit(appevents.APPEVENT, appevents.TYPES.ONACCOUNTMSG, items);
        }
    }    

    this.setUpnpPort = function (callback) {
        try {
            var client = upnp.createClient(logger);
            var port = this.port;
            client.portMapping(
                {
                    public: port,
                    private: port,
                    ttl: 0,  //  not renew, keep opened
                    description: "Streembit UPNP" 
                },
                function (err) {
                    if (err) {
                        logger.error("UPNP portMapping error: %j", err);
                    }

                    appsrvc.upnpgateway = client.upnp_gateway;
                    appsrvc.upnpaddress = client.upnp_local_address;

                    // still return even if there is an error as the port forwarding could have been set up manually
                    callback();
                }
            );
        }
        catch (e) {
            logger.error("UPNP portMapping exception: %j", e);
            callback(e);
        }
    }    

    this.validateContacts = function (callback)  {
        try {
            kad.validate_contacts(this.node, callback);
        }
        catch (e) {
            callback(e);
        }
    }

    this.getseeds = function() {
        var seeds = [];
        if (!this.node) {
            return seeds;
        }

        var buckets = this.node._router._buckets;
        if (buckets) {
            for (var prop in buckets) {
                var bucket = buckets[prop];
                if (bucket._contacts) {
                    for (var i = 0; i < bucket._contacts.length; i++) {
                        seeds.push(bucket._contacts[i]);
                    }
                }
            }
        }

        return seeds;
    }    

    this.onPeerMessage = function(message, info) {
        try {
            if (!message) {
                return streembit.notify.error("Invalid message at onPeerMessage", null, true);
            }
            if (!message.type || message.type != "PEERMSG") {
                return streembit.notify.error("Invalid message type at onPeerMessage", null, true);
            }
            if (!message.data) {
                return streembit.notify.error("Invalid message data at onPeerMessage", null, true);
            }

            //  raise an application event that a peer sent a message
            appevents.peermsg(message.data, info);

        }
        catch (err) {
            logger.error("onPeerMessage error %j", err);
        }
    } 

    this.put = function(key, value, callback) {
        this.node.put(key, value, function (err) {
            if (callback) {
                callback(err);
            }
        });
    }

    this.get = function(key, callback) {
        if (!callback || (typeof callback != "function"))
            throw new Error("invalid callback at node get");

        //  For this public key upload message the key is the device name
        this.node.get(key, function (err, msg) {
            callback(err, msg);
        });
    }

    this.create_peermsg = function (data, notbuffer) {
        var message = {
            type: "PEERMSG",
            data: data
        };
        var strobj = JSON.stringify(message);
        if (notbuffer) {
            return strobj;
        }

        var buffer = new Buffer(strobj);
        return buffer;
    }

    this.peer_send = function (contact, data) {
        try {
            if (!data) {
                throw new Error("peer_send invalid data parameter");
            }
            if (!contact || !contact.address || !contact.port) {
                throw new Error("peer_send invalid contact parameter");
            }

            var message = this.create_peermsg(data);

            var client = net.connect(
                { port: contact.port, host: contact.address },
                function () {
                    client.write(message);
                    client.end();
                }
            );

            client.on('end', function () {
            });

            client.on('error', function (err) {
                logger.error("peer_send failed " + contact.address + ":" + contact.port + ". error: " + (err.message ? err.message : err));
            });

        }
        catch (err) {
            logger.error("peer_send error:  %j", err);
        }
    }

    this.get_range = function (msgkey, callback) {
        try {
            if (!msgkey) {
                throw new Error("get_account_messages invalid msgkey parameter");
            }

            this.node.get_range(msgkey, callback);
        }
        catch (err) {
            logger.error("streembit.PeerTransport.get_range error:  %j", err);
        }
    }

    this.find_contact = function (account, public_key, callback) {
        if (!callback || (typeof callback != "function"))
            throw new Error("invalid callback at find_node");

        //  For this public key upload message the key is the device name
        kad.find_contact(this.node, account, public_key, function (err, contact) {
            if (!err && contact && contact.account == account) {
                contact.protocol = defs.TRANSPORT_TCP;
                contact.name = account;
                callback(err, contact);
            }
            else {
                callback(err, null);
            }
        });
    }    

    this.initNetwork = function (callback) {
        try {
            var self = this;

            this.node = null;

            if (!this.bootseeds || !this.bootseeds.length) {
                return callback("Invalid seeds");
            }

            var seedlist = [];

            for (var i = 0; i < this.bootseeds.length; i++) {
                seedlist.push(this.bootseeds[i]);
                logger.debug("seed: %j", this.bootseeds[i]);
            }

            if (!this.address) {
                throw new Error("address must be passed to node initialization");
            }

            if (!this.port) {
                throw new Error("port must be passed to node initialization");
            }

            var param = {
                address: this.address,
                port: this.port
            };

            var contact = kad.contacts.AddressPortContact(param);

            var transport_options = {
                logger: logger
            };
            var transport = kad.transports.TCP(contact, transport_options);

            transport.after('open', function (next) {
                // exit middleware stack if contact is blacklisted
                logger.info('TCP peer connection is opened');

                // otherwise pass on
                next();
            });

            // message validator
            transport.before('receive', auth.onKadMessage);

            // handle errors from RPC
            transport.on('error', this.onTransportError);

            var db = database.getkaddb();

            var options = {
                transport: transport,
                logger: logger,
                storage: db,
                seeds: seedlist,
                onPeerMessage: this.onPeerMessage,
                expireHandler: auth.expireHandler,
                findRangeMessages: auth.findRangeMessages
            };

            kad.create(options, function (err, peerobj) {
                if (err) {
                    return callback(err);
                }

                logger.debug("kad.create complete");

                self.isconnected = true;
                self.node = peerobj;
                appsrvc.node = peerobj;
                appsrvc.address = param.address;
                appsrvc.port = param.port;
                appsrvc.transport = defs.TRANSPORT_TCP;
                appsrvc.net_connected = true;

                console.log("Peer node has been initialized");

                callback();
            });

        }
        catch (e) {
            callback(e);
        }
    }
}

module.exports = TransportPeerNet;