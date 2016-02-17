﻿'use strict';

var streemio = streemio || {};
// vms refers to ViewModels
streemio.vms = streemio.vms || {};

var nodecrypto = require(global.cryptolib);
var EccKey = require('./libs/crypto/EccKey');

var logger = global.applogger;

(function ($, ko, events, config) {
    
    streemio.vms.LogsViewModel = function () {
        var viewModel = {
            errors: ko.observableArray([]),
            infos: ko.observableArray([]),
            debugs: ko.observableArray([]),
            
            init: function (errlist, infolist, debuglist) {
                try {
                    if (!errlist || !errlist.length) {
                        errlist = [];
                    }
                    if (!infolist || !infolist.length) {
                        infolist = [];
                    }
                    if (!debuglist || !debuglist.length) {
                        debuglist = [];
                    }
                    this.errors(errlist);
                    this.infos(infolist);
                    this.debugs(debuglist);
                }     
                catch (err) {
                    logger.error("add_message error %j", err);
                }
            }
        };
        
        return viewModel;
    }
    
    streemio.vms.MessagesViewModel = function () {
        var viewModel = {
            messages: ko.observableArray([]),
            
            add_message: function (data) {
                try {
                    var payload = streemio.Message.getpayload(data);
                    var sender = payload.iss;
                    
                    streemio.DB.get(streemio.DB.CONTACTDB, sender).then(
                        function (result) {
                            try {
                                var public_key = result.public_key;
                                if (!public_key)
                                    return;
                                
                                var message = streemio.Message.decode(data, public_key);
                                //  
                                var sender_ecdh = message.data.send_ecdh_public;
                                var rcpt_ecdh = message.data.rcpt_ecdh_public;
                                if (!sender_ecdh || !rcpt_ecdh)
                                    return;
                                
                                var ecdhkeys = streemio.User.ecdhkeys;
                                // get the user ecdh key that was used to encrypt the message
                                var ecdh_public_key = null;
                                var ecdh_private_key = null;
                                for (var i = 0; i < ecdhkeys.length; i++) {
                                    if (ecdhkeys[i].ecdh_public_key == rcpt_ecdh) {
                                        ecdh_public_key = ecdhkeys[i].ecdh_public_key;
                                        ecdh_private_key = ecdhkeys[i].ecdh_private_key;
                                        break;
                                    }
                                }
                                
                                if (!ecdh_public_key || !ecdh_private_key) {
                                    logger.error("couldn't find recepient ecdh keys for a message from %s", sender);
                                    return;
                                }
                                
                                var jwe_input = message.data.cipher;
                                var plain_text = streemio.Message.decrypt_ecdh(ecdh_private_key, ecdh_public_key, sender_ecdh, jwe_input);
                                if (plain_text) {
                                    var dataobj = JSON.parse(plain_text);
                                    var msgobj = { sender: message.iss, time: message.iat, data: dataobj };
                                    viewModel.messages.push(msgobj);
                                    //console.log("adding message");
                                }
                            }
                            catch (e) {
                                logger.error("Get sender data from DB error %j", e);
                            }
                        },
                        function (err) {
                            logger.error("Get sender data from DB error %j", err);
                        }                        
                    );
                }     
                catch (err) {
                    logger.error("add_message error %j", err);
                }
            }
        };
        
        return viewModel;
    }
    
    streemio.vms.InfoTaskViewModel = function (task) {
        var viewModel = {
            template: ko.observable('empty-template'),
            
            onupdate: function (value) {
                if (this.type == "file") {
                    this.progress_val(value);
                }
            },
            
            oncomplete: function (verhash, dir, blobitems) {
                if (this.type == "file") {
                    if (viewModel.mode == "send") {
                        this.template("file-send-complete-template");
                    }
                    else {
                        if (streemio.Main.is_gui) {
                            if (verhash == this.hash) {
                                this.savedir(dir)
                                this.template("file-complete-template");
                            }
                            else {
                                //  error, the received file hash does not match with the expected file hash
                                viewModel.onerror("The file transfer completed with an invalid file content.");
                            }
                        }
                        else {
                            
                            var saveByteArray = (function () {
                                var a = document.createElement("a");
                                document.body.appendChild(a);
                                a.style = "display: none";
                                return function (data, name) {
                                    var blob = new Blob(data, { type: "octet/stream" }),
                                        url = window.URL.createObjectURL(blob);
                                    a.href = url;
                                    a.download = name;
                                    a.click();
                                    window.URL.revokeObjectURL(url);
                                };
                            }());
                            
                            saveByteArray(blobitems, this.file_name)
                            
                            this.savedir("local storage")
                            this.template("file-complete-template");
                        }
                    }
                }
            },
            
            onerror: function (err) {
                this.error_msg((err && err.message) ? err.message : err);
                this.template("file-error-template");
            }
        };
        
        viewModel.template(task.type + "-progress-template");
        for (var prop in task) {
            viewModel[prop] = task[prop];
        }
        
        viewModel.contact_name = task.contact.name;
        
        if (task.type == "file") {
            viewModel.progress_val = ko.observable(0);
            viewModel.file_size = ko.observable(task.file_size);
            viewModel.error_msg = ko.observable('');
            viewModel.savedir = ko.observable('');
        }
        
        return viewModel;
    }
    
    streemio.vms.TasksViewModel = function () {
        var viewModel = {
            tasks: ko.observableArray([]),
            isshowpanel: ko.observable(false),
            
            add: function (task) {
                var itemvm = new streemio.vms.InfoTaskViewModel(task);
                this.tasks.push(itemvm);
                viewModel.isshowpanel(true);
            },        
            
            close_task: function (item, ev) {
                try {
                    streemio.FileTransfer.cancel(item.hash);
                }
                catch (e) { }
                viewModel.tasks.remove(item);
                if (viewModel.tasks().length == 0) {
                    viewModel.isshowpanel(false);
                }
            },  
            
            cancel: function (item) {
                // the user cancelled it, send cancel info to the peer
                var message = { cmd: streemio.DEFS.PEERMSG_FEXIT, hash: item.hash };
                streemio.PeerNet.send_peer_message(item.contact, message);
                viewModel.close_task(item);
            },
            
            cancel_by_peer: function (hash) {
                var task = null;
                for (var i = 0; i < this.tasks().length; i++) {
                    if (this.tasks()[i].hash == hash) {
                        task = this.tasks()[i];
                        break;
                    }
                }
                if (task) {
                    task.onerror("The task was cancelled by the peer");
                }
            },
            
            update: function (hash, value) {
                var task = null;
                for (var i = 0; i < this.tasks().length; i++) {
                    if (this.tasks()[i].hash == hash) {
                        task = this.tasks()[i];
                        break;
                    }
                }
                if (task) {
                    task.onupdate(value);
                }
            },
            
            complete: function (hash, verified_hash, dir, blobitems) {
                var task = null;
                for (var i = 0; i < this.tasks().length; i++) {
                    if (this.tasks()[i].hash == hash) {
                        task = this.tasks()[i];
                        break;
                    }
                }
                if (task) {
                    task.oncomplete(verified_hash, dir, blobitems);
                }
            },            
            
            error: function (hash, err) {
                var task = null;
                for (var i = 0; i < this.tasks().length; i++) {
                    if (this.tasks()[i].hash == hash) {
                        task = this.tasks()[i];
                        break;
                    }
                }
                if (task) {
                    task.onerror(err);
                }
            },
        };
        
        return viewModel;
    }
    
    streemio.vms.SendFileViewModel = function (contact, oninitstart, oninitend) {
        var viewModel = {
            contact: contact,
            contact_name: ko.observable(contact.name),
            progressctrl: 0,
            onInitStart: oninitstart, 
            onInitEnd: oninitend, 
            isinprogress: ko.observable(false),
            
            init: function (callback) {
            },            
            
            send_file: function (file) {
                if (!file || !file.name || file.size === 0 || !file.path) {
                    return bootbox.alert("File is empty, please select a non-empty file");
                }
                
                if (file.size > 10000000) {
                    return bootbox.alert("The maximum supported file size of this software version is 10 MB");
                }
                
                viewModel.isinprogress(true);
                
                if (viewModel.onInitStart) {
                    viewModel.onInitStart();
                }
                
                try {
                    streemio.util.fileHash(file.path, function (hash1) {
                        logger.debug("file hash: " + hash1);
                        // ask the contact to accept the file
                        file.hash = hash1;
                        streemio.PeerNet.initfile(viewModel.contact, file, true, 20000)
                        .then(
                            function (isaccepted) {
                                logger.debug("File transfer init result: " + isaccepted);
                                if (isaccepted == true) {
                                    var options = {
                                        contact: viewModel.contact,
                                        file: file,
                                        is_sender: true
                                    };
                                    streemio.FileTransfer.init_send(options);
                                    
                                    if (viewModel.onInitEnd) {
                                        viewModel.onInitEnd();
                                    }
                                    
                                    streemio.Session.tasksvm.add({
                                        type: "file",
                                        mode: "send",
                                        file_name: file.name,
                                        hash: file.hash,
                                        file_size: file.size,
                                        contact: viewModel.contact
                                    });
                                }
                            },
                            function (err) {
                                if (viewModel.onInitEnd) {
                                    viewModel.onInitEnd();
                                }
                                viewModel.isinprogress(false);
                                logger.error("Error in starting file transfer: %j", err);
                                streemio.notify.error("Error in starting file transfer");
                            }
                        )
                    });
                }
                catch (err) {
                    viewModel.isinprogress(false);
                    if (viewModel.onInitEnd) {
                        viewModel.onInitEnd();
                    }
                    logger.error("Error in sending file: %j", err);
                    streemio.notify.error_popup("Error in sending file: %j", err);
                }
            }
           
        };
        
        return viewModel;
    }
    
    streemio.vms.ChatViewModel = function (contact, issession) {
        var viewModel = {
            contact: contact,
            contact_name: ko.observable(contact.name),
            chatitems: ko.observableArray([]),
            chatmsg: ko.observable(''),
            issession: ko.observable(issession),
            templateName: ko.observable('empty-template'),
            
            init: function (callback) {
                try {
                    if (this.issession() != true) {
                        //streemio.notify.info(");
                        BootstrapDialog.show({
                            title: 'User offline',
                            message: "It seems the contact is offline.You can send an offline message to the contact.The network will store the message and deliver it once the contact is online.",
                            onhidden: function (dialogRef) {
                                var content = $("#contact-offline-template").html();
                                BootstrapDialog.show({
                                    title: 'Send offline message to ' + viewModel.contact.name ,
                                    message: content,
                                    buttons: [
                                        {
                                            label: 'Send Message',
                                            action: function (dlgwin) {
                                                var text = $.trim($("#txtOfflineMsg").val());
                                                viewModel.sendoffline(text);
                                                dlgwin.close();
                                                streemio.notify.info("The offline message has been sent to the network. Once the contact is online the message will be delivered", 2000);
                                            }
                                        }, 
                                        {
                                            label: 'Close',
                                            action: function (dlgwin) {
                                                dlgwin.close();
                                            }
                                        }]
                                });
                            }
                        });
                    }
                    else {
                        this.templateName("contact-online-template");
                    }
                    
                    var items = streemio.Session.get_textmsg(this.contact.name);
                    var new_array = items.slice(0);
                    this.chatitems(new_array);
                    
                    callback();
                }
                catch (err) {
                    streemio.notify.error("Chat view error %j", err);
                }
            },            
            
            copy: function () {
            
            },
            
            sendchat: function () {
                try {
                    var msg = $.trim(this.chatmsg());
                    if (msg) {
                        var message = { cmd: streemio.DEFS.PEERMSG_TXTMSG, sender: streemio.User.name, text: msg };
                        streemio.PeerNet.send_peer_message(this.contact, message);
                        //  update the list with the sent message
                        this.onTextMessage(message);
                        this.chatmsg('');
                    }
                }
                catch (err) {
                    streemio.notify.error("Send chat error %j", err);
                }
            },
            
            sendfile: function () {
                if (!streemio.PeerNet.is_peer_session(viewModel.contact.name)) {
                    return streemio.notify.error_popup("Invalid contact session");
                }
                
                streemio.UI.showSendFile(viewModel.contact);
            },  
            
            sendoffline: function (message) {
                var self = this;
                try {
                    if (message) {
                        streemio.PeerNet.send_offline_message(this.contact, message, function () {
                        });
                    }
                }
                catch (err) {
                    streemio.notify.error("Send chat error %j", err);
                }
            },
            
            onTextMessage: function (msg) {
                msg.time = streemio.util.timeNow();
                viewModel.chatitems.push(msg);
                var $cont = $('.chat-text-items');
                $cont[0].scrollTop = $cont[0].scrollHeight;
                streemio.Session.add_textmsg(viewModel.contact.name, msg);
            }
        };
        
        return viewModel;
    }
    
    
    streemio.vms.MediaCallViewModel = function (localvid, remotevid, caller, contobj, calltype, videoconnfn, showchatctrlfn) {
        var viewModel = {
            localVideo: localvid, 
            remoteVideo: remotevid,
            contact: contobj,
            contact_name: ko.observable(contobj.name),
            iscaller: caller,
            calltype: calltype,
            isvideocall: ko.observable(false),
            isaudiocall: ko.observable(false),
            peerhangup: false,
            calltime: ko.observable(0),
            call_timer_obj: null,
            videoConnCallback: videoconnfn,
            showChatCallback: showchatctrlfn,
            chatitems: ko.observableArray([]),
            chatmsg: ko.observable(''),
            ischatdisplay: false,
            isvideo: ko.observable(true),
            isaudio: ko.observable(true),
            
            init: function () {
                this.isvideocall(this.calltype == streemio.DEFS.CALLTYPE_VIDEO);
                this.isaudiocall(this.calltype == streemio.DEFS.CALLTYPE_AUDIO);
                var options = {
                    contact: this.contact,
                    iscaller: this.iscaller,
                    calltype: this.calltype
                };
                streemio.MediaCall.init(localvid, remotevid, options);
            },
            
            toHHMMSS: function (value) {
                var seconds = Math.floor(value),
                    hours = Math.floor(seconds / 3600);
                seconds -= hours * 3600;
                var minutes = Math.floor(seconds / 60);
                seconds -= minutes * 60;
                
                if (hours < 10) { hours = "0" + hours; }
                if (minutes < 10) { minutes = "0" + minutes; }
                if (seconds < 10) { seconds = "0" + seconds; }
                return hours + ':' + minutes + ':' + seconds;
            },
            
            calltimeproc: function () {
                var value = 0;
                viewModel.call_timer_obj = setInterval(function () {
                    value++;
                    var txt = viewModel.toHHMMSS(value);
                    viewModel.calltime(txt);
                }, 1000);
            },
            
            onRemoteVideoConnect: function () {
                if (viewModel.calltype == streemio.DEFS.CALLTYPE_VIDEO) {
                    if (viewModel.videoConnCallback) {
                        viewModel.videoConnCallback();
                    }
                }
                
                viewModel.calltimeproc();
            },          
            
            sendfile: function () {
                if (!streemio.PeerNet.is_peer_session(viewModel.contact.name)) {
                    return streemio.notify.error_popup("Invalid contact session");
                }
                
                streemio.UI.showSendFile(viewModel.contact);
            },  
            
            showchat: function () {
                if (viewModel.showChatCallback) {
                    viewModel.showChatCallback(function () {
                        // initialize the chat items
                        var items = streemio.Session.get_textmsg(viewModel.contact.name);
                        var new_array = items.slice(0);
                        viewModel.chatitems(new_array);
                        viewModel.ischatdisplay = true;
                    });
                }
            },  
            
            add_video: function () {
                streemio.MediaCall.show_video(function () {
                    viewModel.isvideo(true);
                    // TODO send to the peer
                });
            },            
            
            remove_video: function () {
                streemio.MediaCall.hide_video(function () {
                    viewModel.isvideo(false);
                    // TODO send to the peer
                });
            },
            
            add_audio: function () {
                streemio.MediaCall.toggle_audio(true, function () {
                    viewModel.isaudio(true);
                    // TODO send to the peer
                });
            },
            
            remove_audio: function () {
                streemio.MediaCall.toggle_audio(false, function () {
                    viewModel.isaudio(false);
                    // TODO send to the peer
                });
            },
            
            hangup: function () {
                streemio.MediaCall.hangup();
                streemio.PeerNet.hangup_call(viewModel.contact);
                // navigate to empty screen
                events.emit(events.TYPES.ONAPPNAVIGATE, streemio.DEFS.CMD_EMPTY_SCREEN);
                if (viewModel.call_timer_obj) {
                    clearTimeout(viewModel.call_timer_obj);
                }
            },
            
            dispose: function () {
                try {
                    logger.debug("MediaCallViewModel dispose");
                    streemio.MediaCall.hangup();
                    if (!viewModel.peerhangup) {
                        streemio.PeerNet.hangup_call(viewModel.contact);
                    }
                    if (viewModel.call_timer_obj) {
                        clearTimeout(viewModel.call_timer_obj);
                    }
                }
                catch (err) {
                    streemio.notify.error("Mediacall dispose %j", err);
                }
            },
            
            sendchat: function () {
                try {
                    var msg = $.trim(this.chatmsg());
                    if (msg) {
                        var message = { cmd: streemio.DEFS.PEERMSG_TXTMSG, sender: streemio.User.name, text: msg };
                        streemio.PeerNet.send_peer_message(this.contact, message);
                        //  update the list with the sent message
                        this.onTextMessage(message);
                        this.chatmsg('');
                    }
                }
                catch (err) {
                    streemio.notify.error("Send chat error %j", err);
                }
            },
            onTextMessage: function (msg) {
                msg.time = streemio.util.timeNow();
                viewModel.chatitems.push(msg);
                var $cont = $('.chat-text-items');
                $cont[0].scrollTop = $cont[0].scrollHeight;
                streemio.Session.add_textmsg(viewModel.contact.name, msg);
                if (viewModel.ischatdisplay == false) {
                    viewModel.showchat();
                }
            }
        };
        
        return viewModel;
    }
    
    
    streemio.vms.ContactViewModel = function (data) {
        var viewModel = {
            name: ko.observable(data.name),
            address: ko.observable(data.address),
            port: ko.observable(data.port),
            public_key: ko.observable(data.public_key),
            type: ko.observable(data.type),            
            contact: data,
            
            call: function (type) {
                var call_type;
                if (type == 'video') {
                    call_type = streemio.DEFS.CALLTYPE_VIDEO;
                }
                else if (type == 'audio') {
                    call_type = streemio.DEFS.CALLTYPE_AUDIO;
                }
                
                streemio.PeerNet.ping(this.contact, true, 5000)
                .then(
                    function () {
                        return streemio.PeerNet.get_contact_session(viewModel.contact);
                    },
                    function (err) {
                        throw new Error(err);
                    }
                )
                .then(
                    function () {
                        return streemio.PeerNet.call(viewModel.contact, call_type, true);
                    },
                    function (err) {
                        throw new Error(err);
                    }
                )
                .then(
                    function (isaccepted) {
                        logger.debug("Call accepted: " + isaccepted);
                        if (isaccepted == true) {
                            var uioptions = {
                                contact: viewModel.contact,
                                calltype: call_type,
                                iscaller: true
                            };
                            events.emit(events.TYPES.ONAPPNAVIGATE, streemio.DEFS.CMD_VIDEO_CALL, null, uioptions);
                        }
                        else if (isaccepted == false) {
                            streemio.notify.info("Contact " + viewModel.contact.name + " declined the call");
                        }
                        else {
                            streemio.notify.error("Unable to establish call with contact " + viewModel.contact.name);
                        }
                    },
                    function (err) {
                        logger.error("Error in starting video call: %j", err);
                        streemio.notify.error("Error in starting video call");
                    }
                );
            },
            
            chat: function () {
                streemio.PeerNet.ping(this.contact, true, 5000)
                .then(
                    function () {
                        return streemio.PeerNet.get_contact_session(viewModel.contact);
                    },
                    function (err) {
                        throw new Error(err);
                    }
                )
                .then(
                    function (session) {
                        var options = {
                            contact : viewModel.contact,
                            issession: session ? true : false
                        };
                        events.emit(events.TYPES.ONAPPNAVIGATE, streemio.DEFS.CMD_CONTACT_CHAT, null, options);
                    },
                    function (err) {
                        logger.error("Error in creating peer session: %j", err);
                        // still open the view and indicate the contact is offline
                        var options = {
                            contact : viewModel.contact,
                            issession: false
                        };
                        events.emit(events.TYPES.ONAPPNAVIGATE, streemio.DEFS.CMD_CONTACT_CHAT, null, options);
                    }
                );
            },
            
            sendfile: function () {
                streemio.PeerNet.ping(this.contact, true, 5000)
                .then(
                    function () {
                        return streemio.PeerNet.get_contact_session(viewModel.contact);
                    },
                    function (err) {
                        throw new Error(err);
                    }
                )
                .then(
                    function (session) {
                        streemio.UI.showSendFile(viewModel.contact);
                    },
                    function (err) {
                        logger.error("Error in starting file transfer: %j", err);
                        streemio.notify.error("Error in starting file transfer");
                    }
                );
            },
            
            keyexch: function () {
                streemio.PeerNet.get_contact_session(this.contact)
                .then(
                    function () {
                        streemio.notify.success("Secure session has been created with " + viewModel.contact.name);
                    },
                    function (err) {
                        logger.error("Error in creating peer session: %j", err);
                        streemio.notify.error("Error in creating peer session");
                    });
            },
            
            remove: function () {
                streemio.Session.contactsvm.remove_byname(this.name(), function () {
                    events.emit(events.TYPES.ONAPPNAVIGATE, streemio.DEFS.CMD_EMPTY_SCREEN);
                });
            }
        };
        
        return viewModel;
    }
    
    streemio.vms.FileListViewModel = function (files) {
        
        var Contact = {
            actionicon: ko.observable(""),
            actiontype: "",
            usertypeicon: "",
            files: ko.observableArray([])
        };
        
        var viewModel = {
            files: ko.observableArray(files)
        };
        
        return viewModel;
    }
    
    
    streemio.vms.ContactsListViewModel = function () {
        
        function merge(contact, param) {
            for (var prop in param) {
                if (!contact[prop]) {
                    contact[prop] = param[prop];
                }
            }
            return contact;
        }
        
        var Contact = {
            actionicon: ko.observable(""),
            actiontype: "",
            usertypeicon: "",
            files: ko.observableArray([])
        };
        
        var viewModel = {
            contacts: ko.observableArray([]),
            contact_lookup: ko.observable(),
            issearch: ko.observable(false),
            
            init: function (list) {
                if (list && list.length) {
                    for (var i = 0; i < list.length; i++) {
                        var exists = false;
                        for (var j = 0; j < viewModel.contacts().length; j++) {
                            if (list[i].name == viewModel.contacts()[j].name) {
                                exists = true;
                                break;
                            }
                        }
                        if (exists) {
                            continue;
                        }
                        
                        var contact = Object.create(Contact);
                        if (list[i].user_type == "human") {
                            contact.usertypeicon = "glyphicon glyphicon-user";
                        }
                        else if (list[i].user_type == "device") {
                            contact.usertypeicon = "glyphicon glyphicon-cog";
                        }
                        var contobj = merge(contact, list[i]);
                        viewModel.contacts.push(contobj);
                    }
                }
            },          
            
            dosearch: function () {
                if (!streemio.Main.is_node_initialized) {
                    return streemio.notify.error_popup("The Streemio account is not initialized. First log-in with your Streemio account");
                }
                
                viewModel.issearch(!viewModel.issearch());
            },  
            
            onTextMessage: function (data) {
                try {
                    var contacts = viewModel.contacts();
                    for (var i = 0; i < contacts.length; i++) {
                        if (contacts[i].name == data.sender) {
                            contacts[i].actionicon("glyphicon glyphicon-envelope");
                            contacts[i].actiontype = "textmsg";
                            data.time = streemio.util.timeNow();
                            streemio.Session.add_textmsg(data.sender, data);
                            break;
                        }
                    }
                }
                catch (err) {
                    //TODO
                }
            },
            
            onFileReceive: function (sender, blob, filename, filesize) {
                try {
                    var contacts = viewModel.contacts();
                    for (var i = 0; i < contacts.length; i++) {
                        if (contacts[i].name == sender) {
                            contacts[i].actionicon("glyphicon glyphicon-file");
                            contacts[i].actiontype = "filercv";
                            var fileobj = {
                                blob: blob,
                                name: filename,
                                size: filesize
                            };
                            contacts[i].files.push(fileobj);
                            break;
                        }
                    }
                }
                catch (err) {
                    //TODO
                }
            },
            
            itemAction: function (item) {
                try {
                    if (item.actiontype == "textmsg") {
                        var options = {
                            contact : item,
                            issession: true
                        };
                        events.emit(events.TYPES.ONAPPNAVIGATE, streemio.DEFS.CMD_CONTACT_CHAT, null, options);
                        item.actiontype = "";
                        item.actionicon("");
                    }
                    else if (item.actiontype == "filercv") {
                        events.emit(events.TYPES.ONAPPNAVIGATE, streemio.DEFS.CMD_CONTACT_FILERCV, item);
                        item.actiontype = "";
                        item.actionicon("");
                    }
                }
                catch (err) {
                    //TODO
                }
            },
            
            itemSelect: function (item) {
                events.emit(events.TYPES.ONAPPNAVIGATE, streemio.DEFS.CMD_CONTACT_SELECT, item);
            },
            
            remove: function (item) {
                bootbox.confirm("Contact '" + item.name + "' will be removed from the contacts list.", function (result) {
                    if (result) {
                        streemio.Contacts.remove(item.name, function () {
                            viewModel.contacts.remove(item);
                            events.emit(events.TYPES.ONAPPNAVIGATE, streemio.DEFS.CMD_EMPTY_SCREEN);
                        });
                    }
                });
            },
            
            remove_byname: function (account, callback) {
                var item = null;
                for (var i = 0; i < viewModel.contacts().length; i++) {
                    if (viewModel.contacts()[i].name == account) {
                        item = viewModel.contacts()[i];
                        break;
                    }
                }
                if (!item)
                    return;
                
                bootbox.confirm("Contact '" + item.name + "' will be removed from the contacts list.", function (result) {
                    if (result) {
                        // delete from the local db
                        streemio.Contacts.remove(item.name, function () {
                            viewModel.contacts.remove(item);
                            events.emit(events.TYPES.ONAPPNAVIGATE, streemio.DEFS.CMD_EMPTY_SCREEN);
                        });
                    }
                });
            },
            
            delete_byname: function (account, callback) {
                var item = null;
                for (var i = 0; i < viewModel.contacts().length; i++) {
                    if (viewModel.contacts()[i].name == account) {
                        item = viewModel.contacts()[i];
                        break;
                    }
                }
                if (!item)
                    return;
                
                viewModel.contacts.remove(item);
            },
            
            add_contact: function (result) {
                if (result) {
                    var exists = false;
                    for (var j = 0; j < viewModel.contacts().length; j++) {
                        if (result.name == viewModel.contacts()[j].name) {
                            exists = true;
                            break;
                        }
                    }
                    if (exists) {
                        return;
                    }

                    var contact = Object.create(Contact);
                    if (result.user_type == "human") {
                        contact.usertypeicon = "glyphicon glyphicon-user";
                    }
                    else if (result.user_type == "device") {
                        contact.usertypeicon = "glyphicon glyphicon-cog";
                    }
                    var contobj = merge(contact, result);
                    viewModel.contacts.push(contobj);
                }
            },
            
            search: function () {
                try {
                    var self = this;
                    var account = $.trim(this.contact_lookup());
                    if (!account) {
                        return streemio.notify.error_popup("Enter the human or device account name");
                    }
                    
                    if (streemio.Contacts.exists(account)) {
                        return;
                    }
                    
                    streemio.Contacts.search(account, function (result) {
                        if (result) {
                            var contact = Object.create(Contact);
                            if (result.user_type == "human") {
                                contact.usertypeicon = "glyphicon glyphicon-user";
                            }
                            else if (result.user_type == "device") {
                                contact.usertypeicon = "glyphicon glyphicon-cog";
                            }
                            var contobj = merge(contact, result);
                            viewModel.contacts.push(contobj);
                        }
                    });
                    
                }
                catch (err) {
                    logger.error("contact search error %j", err)
                }
            }

        };
        
        
        return viewModel;
    }
    
    streemio.vms.UpdateKeyViewModel = function (validatePassword, validatePasswordConfirm) {
        var viewModel = {
            private_key_pwd: ko.observable(),
            private_key_pwd_conf: ko.observable(),
            
            init: function (callback) {
                callback(null);
            },
            
            onPasswordChange: function () {
                var val = $.trim(this.private_key_pwd());
                
                if (!val) {
                    validatePassword(false, "Password is required");
                    return false;
                }
                if (val.length < 8) {
                    validatePassword(false, "The password must be at least 8 characters");
                    return false;
                }
                if (val.indexOf(' ') > -1) {
                    validatePassword(false, "The password must not contain empty space");
                    return false;
                }
                var ck_letters = /[A-Za-z]/;
                if (!ck_letters.test(val)) {
                    validatePassword(false, "The password must contain at least one letter.");
                    return false;
                }
                var ck_nums = /\d/;
                if (!ck_nums.test(val)) {
                    validatePassword(false, "The password must contain at least one digit.");
                    return false;
                }
                
                var ck_specchar = /[!@#$£%^&*]/;
                var valid = ck_specchar.test(val);
                if (!valid) {
                    validatePassword(false, "The password must contain at least one special character.");
                    return false;
                }
                
                validatePassword(true);
                return true;
                
            },
            
            onPasswordConfirmChange: function () {
                var val = $.trim(this.private_key_pwd_conf());
                if (!val) {
                    validatePasswordConfirm(false, "Password confirm is required");
                    return false;
                }
                
                var pwd = $.trim(this.private_key_pwd());
                if (pwd != val) {
                    validatePasswordConfirm(false, "The password and its confirm are not the same");
                    return false;
                }
                
                validatePasswordConfirm(true);
                return true;
            },
            
            
            update_account: function () {
                try {
                    var valid = this.onPasswordChange();
                    if (!valid) return;
                    
                    valid = this.onPasswordConfirmChange();
                    if (!valid) return;
                    
                    // call the viewmodel
                    var pwd = this.private_key_pwd();
                    
                    streemio.User.update_public_key(pwd);
                }
                catch (err) {
                    streemio.notify.error("Update passphrase error %j", err);
                }
            }
            
        };
        
        return viewModel;
    }
    
    streemio.vms.AccountInfoViewModel = function () {
        var viewModel = {
            account: ko.observable(streemio.User.name),
            public_key: ko.observable(streemio.User.public_key)
        };
        
        return viewModel;
    }
    
    streemio.vms.UserViewModel = function (newaccount, validateAccount, validatePassword, validatePasswordConfirm, validatePrivateSeedHost, validatePrivateSeedPort, validatePrivateSeedAccount) {
        var viewModel = {
            account: ko.observable(),
            private_key_pwd: ko.observable(),
            private_key_pwd_conf: ko.observable(),
            is_new_account: ko.observable(newaccount),
            accounts: ko.observableArray([]),
            selected_account: ko.observable(),
            is_account_exists: ko.observable(false),
            is_private_network: ko.observable(false),
            private_net_host: ko.observable(),
            private_net_account: ko.observable(),
            private_net_port: ko.observable(),
            
            init: function (callback) {
                viewModel.is_private_network(streemio.Main.network_type == streemio.DEFS.PRIVATE_NETWORK);
                if (streemio.Main.network_type == streemio.DEFS.PRIVATE_NETWORK) {
                    if (config && config.private_net_seed) {
                        if (config.private_net_seed.account) {
                            viewModel.private_net_account(config.private_net_seed.account);
                        }
                        if (config.private_net_seed.host) {
                            viewModel.private_net_host(config.private_net_seed.host);
                        }
                        if (config.private_net_seed.port) {
                            viewModel.private_net_port(config.private_net_seed.port);
                        }
                    }
                }
                
                if (!newaccount) {
                    this.get_accounts(function () {
                        callback(null);
                    });
                }
                else {
                    viewModel.accounts([]);
                    callback(null);
                }
            },
            
            get_accounts: function (callback) {
                streemio.DB.getall(streemio.DB.ACCOUNTSDB, function (err, result) {
                    if (err) {
                        return streemio.notify.error_popup("streemio.DB.getall accounts error %j", err);
                    }
                    
                    if (!result || !result.length) {
                        viewModel.is_new_account(true);
                        viewModel.accounts([]);
                        viewModel.is_account_exists(false);
                    }
                    else {
                        viewModel.accounts(result);
                        viewModel.is_account_exists(true);
                    }
                    callback();
                });
            },  
            
            set_newaccount_mode: function () {
                this.is_new_account(true);
            },  
            
            check_account_exists: function (account, callback) {
                if (!account) {
                    return alert("Account name is required");
                }
                
                if (this.avaialable_acc == account) {
                    //  show the check icon
                    return;
                }
                
                streemio.PeerNet.find_contact(account, function (err, contact) {
                    if (err) {
                        // check the error
                        if (err.message && err.message.indexOf("0x0100") > -1) {
                            // 0x0100 error indicates the key does not exists
                            return callback(null, false);
                        }
                    }
                    var exists = contact && contact.name == account;
                    callback(null, exists);
                });
            },
            
            validateAccountText: function () {
                var val = $.trim(this.account());
                var ck_account = /^[A-Za-z0-9]{6,20}$/;
                if (!ck_account.test(val)) {
                    validateAccount(false, "The account name must be between 6-20 characters and it can only contain alphanumeric characters (letters a-z, A-Z and numbers 0-9)");
                    return false;
                }
                else {
                    validateAccount(true);
                    return val;
                }
            },
            
            onAccountChange: function () {
                var val = $.trim(this.account());
                if (this.is_new_account() == false) {
                    if (!val) {
                        validateAccount(false, "The account name is required");
                        return false;
                    }
                    else {
                        validateAccount(true);
                        return true;
                    }
                }
                else {
                    var val = this.validateAccountText();
                    if (!val) {
                        return;
                    }
                    
                    this.check_account_exists(val, function (err, exists) {
                        if (err) {
                            return streemio.notify.error(err);
                        }
                        if (exists) {
                            validateAccount(false, "Account '" + val + "' already exists on the network. Please define an other account name");
                        }
                        else {
                            validateAccount(true);
                        }
                    });
                }
            },
            
            onPasswordChange: function () {
                var val = $.trim(this.private_key_pwd());
                
                if (this.is_new_account() == false) {
                    if (!val) {
                        validatePassword(false, "Password is required");
                        return false;
                    }
                    else {
                        validatePassword(true);
                        return true;
                    }
                }
                else {
                    if (!val) {
                        validatePassword(false, "Password is required");
                        return false;
                    }
                    if (val.length < 8) {
                        validatePassword(false, "The password must be at least 8 characters");
                        return false;
                    }
                    if (val.indexOf(' ') > -1) {
                        validatePassword(false, "The password must not contain empty space");
                        return false;
                    }
                    var ck_letters = /[A-Za-z]/;
                    if (!ck_letters.test(val)) {
                        validatePassword(false, "The password must contain at least one letter.");
                        return false;
                    }
                    var ck_nums = /\d/;
                    if (!ck_nums.test(val)) {
                        validatePassword(false, "The password must contain at least one digit.");
                        return false;
                    }
                    
                    var ck_specchar = /[!@#$£%^&*]/;
                    var valid = ck_specchar.test(val);
                    if (!valid) {
                        validatePassword(false, "The password must contain at least one special character.");
                        return false;
                    }
                    
                    validatePassword(true);
                    return true;
                }
            },
            
            onPasswordConfirmChange: function () {
                var val = $.trim(this.private_key_pwd_conf());
                if (!val) {
                    validatePasswordConfirm(false, "Password confirm is required");
                    return false;
                }
                
                var pwd = $.trim(this.private_key_pwd());
                if (pwd != val) {
                    validatePasswordConfirm(false, "The password and its confirm are not the same");
                    return false;
                }
                
                validatePasswordConfirm(true);
                return true;
            },
            
            
            onPrivateSeedHostChange: function () {
                var val = $.trim(this.private_net_host());
                if (!val) {
                    validatePrivateSeedHost(false, "Host is required for private Streemio seed");
                    return false;
                }
                
                var index = val.indexOf(".");
                if (index == -1) {
                    validatePrivateSeedHost(false, "An IP address or domain name is required for private Streemio seed");
                    return false;
                }
                
                validatePrivateSeedHost(true);
                return true;
            },
            
            onPrivateSeedPortChange: function () {
                var val = $.trim(this.private_net_port());
                if (!val) {
                    validatePrivateSeedPort(false, "Port is required for private Streemio seed");
                    return false;
                }
                
                try {
                    if (isNaN(val)) {
                        validatePrivateSeedPort(false, "A numeric port value is required for a private Streemio seed");
                        return false;
                    }
                }
                catch (e) {
                    validatePrivateSeedPort(false, "A numeric port value is required for a private Streemio seed");
                    return false;
                }
                
                validatePrivateSeedPort(true);
                return true;
            },
            
            onPrivateSeedAccountChange: function () {
                var val = $.trim(this.private_net_account());
                if (!val) {
                    validatePrivateSeedAccount(false, "Account is required for private Streemio seed");
                    return false;
                }
                
                validatePrivateSeedAccount(true);
                return true;
            },
            
            create_account: function () {
                try {
                    var valid;
                    
                    if (this.is_private_network() == true) {
                        valid = this.onPrivateSeedHostChange();
                        if (!valid) return;
                        
                        valid = this.onPrivateSeedPortChange();
                        if (!valid) return;
                        
                        valid = this.onPrivateSeedAccountChange();
                        if (!valid) return;
                        
                        var seed = {
                            account: $.trim(this.private_net_account()),
                            host: $.trim(this.private_net_host()),
                            port: parseInt($.trim(this.private_net_port()))
                        }
                        
                        streemio.Main.private_net_seed = seed;
                    }
                    
                    var account = this.validateAccountText();
                    if (!account) return;
                    
                    valid = this.onPasswordChange();
                    if (!valid) return;
                    
                    valid = this.onPasswordConfirmChange();
                    if (!valid) return;
                    
                    // call the viewmodel
                    var pwd = this.private_key_pwd();
                    
                    streemio.User.create_account(account, pwd, function () {
                        streemio.notify.success("The account has been created");
                        events.emit(events.TYPES.ONAPPNAVIGATE, streemio.DEFS.CMD_EMPTY_SCREEN);
                    });
                }
                catch (err) {
                    streemio.notify.error("Create account error %j", err);
                }
            },
            
            login: function () {
                try {
                    var valid;
                    
                    if (this.is_private_network() == true) {
                        valid = this.onPrivateSeedHostChange();
                        if (!valid) return;
                        
                        valid = this.onPrivateSeedPortChange();
                        if (!valid) return;
                        
                        valid = this.onPrivateSeedAccountChange();
                        if (!valid) return;
                        
                        var seed = {
                            account: $.trim(this.private_net_account()),
                            host: $.trim(this.private_net_host()),
                            port: parseInt($.trim(this.private_net_port()))
                        }
                        
                        streemio.Main.private_net_seed = seed;
                    }
                    
                    var account = this.selected_account();
                    if (!account) {
                        validateAccount(false, "Select an account from the dropdown list");
                        return;
                    }
                    
                    valid = this.onPasswordChange();
                    if (!valid) return;
                    
                    var pwd = this.private_key_pwd();
                    
                    streemio.User.initialize(account, pwd, function (err) {
                        streemio.notify.success("The account has been initialized");
                        events.emit(events.TYPES.ONAPPNAVIGATE, streemio.DEFS.CMD_EMPTY_SCREEN);
                    });

                }
                catch (err) {
                    streemio.notify.error("Create account error %j", err);
                }
            },

        };
        
        return viewModel;
    }
    
    streemio.vms.MainViewModel = function (container) {
        var viewModel = {
            container: container,
            template_name: ko.observable('empty-template'),
            template_datactx: ko.observable(),
            
            init: function () {      
            }
        };
        
        var resetView = function () {
            if (streemio.Session.curent_viewmodel && streemio.Session.curent_viewmodel.dispose) {
                streemio.Session.curent_viewmodel.dispose();
            }
            streemio.notify.hide();
            streemio.Session.curent_viewmodel = 0;
            $(container).empty();
            $(container).append('');
        };
        
        var resetTemplate = function (datactx, view) {
            viewModel.template_name('empty-template');
            viewModel.template_datactx(null);
        }
        
        var showView = function (view) {
            streemio.util.loadView(view, function (html) {
                if (!html) {
                    return alert("Error in loading the " + view + " view ");
                }
                
                streemio.Session.curent_viewmodel = 0;
                $(container).empty();
                $(container).append(html);
            });
        }
        
        events.on(events.TYPES.ONAPPNAVIGATE, function (cmd, datactx, options) {
            try {
                var view;
                var vm;
                switch (cmd) {

                    case streemio.DEFS.CMD_CONTACT_SELECT:
                        resetView();
                        var contactvm = new streemio.vms.ContactViewModel(datactx);
                        viewModel.template_datactx(contactvm);
                        viewModel.template_name("contact-details-template");
                        break;
            
                    case streemio.DEFS.CMD_HANGUP_CALL:
                        if (streemio.Session.curent_viewmodel) {
                            if (streemio.Session.curent_viewmodel.hasOwnProperty('peerhangup')) {
                                streemio.Session.curent_viewmodel.peerhangup = true;
                            }
                        }
                        resetTemplate();
                        resetView();
                        streemio.notify.info("The call has been terminated by the contact");
                        break;

                    case streemio.DEFS.CMD_VIDEO_CALL:
                        if (!options || !options.contact) {
                            return streemio.notify.error("Invalid video call UI options");
                        }
                        resetTemplate();
                        streemio.Session.uioptions = options;
                        showView("mediacall");
                        break;

                    case streemio.DEFS.CMD_CONTACT_CHAT:
                        resetTemplate();
                        streemio.Session.uioptions = options;
                        showView("chat");
                        break;

                    case streemio.DEFS.CMD_CONTACT_FILERCV:
                        var file = datactx;
                        streemio.UI.showContactFile(file);
                        break;

                    case streemio.DEFS.CMD_FILE_INIT:
                        var sender = datactx;
                        var file_params = options;
                        streemio.UI.receiveFile(sender, file_params);
                        break;

                    case streemio.DEFS.CMD_INIT_USER:
                        resetTemplate();
                        resetView();
                        streemio.Session.uioptions = options;
                        showView("inituser");
                        break;

                    case streemio.DEFS.CMD_CHANGE_KEY:
                        resetTemplate();
                        resetView();
                        showView("changekey");
                        break;

                    case streemio.DEFS.CMD_ACCOUNT_INFO:
                        resetTemplate();
                        resetView();
                        showView("accountinfo");
                        break;

                    case streemio.DEFS.CMD_HELP:
                        resetTemplate();
                        resetView();
                        showView("help");
                        break;

                    case streemio.DEFS.CMD_EMPTY_SCREEN:
                        resetTemplate();
                        resetView();
                        break

                    default:
                        break;
                }
            }
            catch (err) {
                logger.error("events.on(events.TYPES.ONAPPNAVIGATE error %j", err);
            }
        });
        
        return viewModel;
    }

})($, ko, global.appevents, global.appconfig);