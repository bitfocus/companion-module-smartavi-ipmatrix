const { InstanceBase, InstanceStatus, runEntrypoint, TCPHelper, Regex } = require('@companion-module/base')

class UsbMatrixInstance extends InstanceBase {

	actions = {}
	variables = {}
	presets = {}
	state = { destinationConnectionList: {}, selectedSource: {}, selectedDestination: {} }

	deviceType = 'unknown'
	inputs = {}
	outputs = {}

	pollingInterval = undefined

	constructor(internal) {
		super(internal)
		this.instanceOptions.disableVariableValidation = true
	}

	// MARK: Configuration
	getConfigFields() {
		return [
			{
				type: 'textinput',
				id: 'host',
				label: 'Device IP',
				width: 12,
				regex: Regex.IP,
			},
			{
				type: 'dropdown',
				id: 'type',
				label: 'Matrix Type',
				width: 12,
				default: 1,
				choices: [
					{id: 1, label: 'MU-88'},
					{id: 2, label: 'MXU-88'},
					{id: 3, label: 'DVR 16x16'},
					{id: 4, label: 'MXCORE 32x32'},
				]
			},
			{
				type: 'textinput',
				id: 'frame',
				label: 'Frame Number',
				width: 12,
				regex: Regex.NUMBER,
				default: '00'
			},
		]
	}

	// MARK: destroy
	async destroy() {
		if (this.socket !== undefined) {
			this.stopPolling()
			this.socket.destroy()
		}

		this.log('info', 'destroy ' + this.id)
	}

	// MARK: init
	async init(config) {
		this.config = config
		this.device = this.deviceConfig(this.config.type)
		this.initState(this.state, this.device)
		this.updateStatus(InstanceStatus.Connecting)
		this.initTCP()
		this.updateGui()
	}

	// MARK: start polling
	startPolling() {
		if (this.pollingInterval) this.stopPolling()
		this.pollingInterval = setInterval(this.getDeviceRoutes.bind(this), 4000)
	}

	// MARK: stop polling
	stopPolling() {
		if (this.pollingInterval) {
			clearInterval(this.pollingInterval)
			delete this.pollingInterval
		}

	}

	// MARK: device config
	deviceConfig(type) {
		const defaultFormatter = num => num.toString().padStart(2, '0')
		const defaultParser = (val) => {
			let raw
			if (typeof val !== 'number') {
				raw = val.charCodeAt(0)
			} else {
				raw = val
			}
			if (raw & 0b10000000 == 0) {
				// value is not valid
				return null
			}
			if (raw === 0xff) {
				// output is unassigned
				return 0
			}
			if ((raw & 0b1100000) > 0) {
				// undocumented and unknown state, but webinterface shows as disconnected, so we will do the same
				return 0
			}
			return (0b1111 & raw) + 1
		}
		/**
		 * @type {{
		 * 	name: string, 
		 * 	commandtype: 'checksum', 
		 * 	inputs: number, 
		 * 	outputs: number, 
		 * 	inputFormatter: (input: number) => string, 
		 * 	outputFormatter: (output: number) => string, 
 		 * 	inputParser: (input: number | string) => number, 
		 * 	outputParser: (output: number | string) => number, 
		 * 	levels: {id: string | number, label: string, positionInQ: number | undefined}[],
		 * 	inputChoices?: {id: string | number, label: string}[],
		 * 	outputChoices?: {id: string | number, label: string}[],
		 * }}
		 * 
		 * @description In state current inputs and outputs will be addressed like 1 = 1,
		 * @description formatting and parsing will be applied when sending or receiving.
		 * @description positionInQ in levels marks if the outputs are returned from a Q command and at which position they start
		 */
		let deviceconfig = {
					name: '16x16',
					commandtype: 'checksum',
					inputs: 16,
					outputs: 16,
					inputFormatter: defaultFormatter,
					outputFormatter: defaultFormatter,
					inputParser: defaultParser,
					outputParser: defaultParser,
					levels: [{id: 'V', label: 'HDMI', positionInQ: 0}],
				};

		switch (type) {
			case 1:
				deviceconfig = {
					...deviceconfig,
					name: 'MU-88',
					inputs: 8,
					outputs: 8,
					levels: [{id: 'U', label: 'USB', positionInQ: 8}],
				}
				break;

			case 2:
				deviceconfig = {
					...deviceconfig,
					name: 'MXU-88',
					inputs: 8,
					outputs: 8,
					levels: [{id: 'V', label: 'HDMI', positionInQ: 0},{id: 'U', label: 'USB', positionInQ: 8}],
				}
				break;

			case 3:
				deviceconfig = {
					...deviceconfig,
					name: 'DVR 16x16',
					inputs: 16,
					outputs: 16,
					levels: [{id: 'U', label: 'HDMI', positionInQ: 0}],
				}
				break;

			case 4:
				deviceconfig = {
					...deviceconfig,
					name: 'MXCORE 32X32',
					inputs: 32,
					outputs: 32,
					levels: [{id: 'U', label: 'HDMI', positionInQ: 0},{id: 'R', label: 'RS-232', positionInQ: 32}],
				}
				break;
		
			default:
				this.log('warn', 'Configured device type not found, using default values')
				break;
		}
		deviceconfig.inputChoices = Array.from(
			{ length: deviceconfig.inputs },
			(_, i) => {return { id: i+1,  label: `Input ${i+1}`}}
		)
		deviceconfig.outputChoices = Array.from(
			{ length: deviceconfig.outputs },
			(_, i) => {return { id: i+1,  label: `Output ${i+1}`}}
		)
		return deviceconfig
	}

	// MARK: init state
	initState(state, device) {
		for (let level of device.levels) {
			state.destinationConnectionList[level.id] = Array.from({length: device.outputs + 1}, () => 0)
			state.selectedSource[level.id] = -2
			state.selectedDestination[level.id] = -2
		}
	}

	// MARK: init actions
	initActions() {
		// MARK: action xpt
		this.actions['xpt'] = {
			name: 'XP:Switch - Select input for output',
			options: [
				{
					label: 'Input',
					type: 'dropdown',
					id: 'input',
					choices: this.device.inputChoices,
					default: this.device.inputChoices[0].id || '',
				},
				{
					label: 'Output',
					type: 'dropdown',
					id: 'output',
					choices: this.device.outputChoices,
					default: this.device.outputChoices[0].id || '',
				},
				{
					label: 'Levels',
					type: 'multidropdown',
					id: 'levels',
					choices: this.device.levels,
					default: this.device.levels.map(choice => choice.id),
				}
			],
			callback: ({options}) => {
					this.XPT(options)
			},
		}
		// MARK: action select source
		this.actions['selectSource'] = {
			name: 'Select source for take',
			options: [
				{
					label: 'Source',
					type: 'dropdown',
					id: 'port',
					choices: this.device.inputChoices,
					default: this.device.inputChoices[0].id || '',
				},
				{
					label: 'Levels',
					type: 'multidropdown',
					id: 'levels',
					choices: this.device.levels,
					default: this.device.levels.map(choice => choice.id),
				}
			],
			callback: ({options}) => {
				for (let level of options.levels) {
					if (this.state.selectedSource[level] == options.port) {
						this.state.selectedSource[level] = 0xffff
					} else {
						this.state.selectedSource[level] = options.port
					}
					this.checkFeedbacks('sourceSelected', 'route')
				}
			},
		}
		// MARK: action select destination
		this.actions['selectDestination'] = {
			name: 'Select destination for take',
			options: [
				{
					label: 'Destination',
					type: 'dropdown',
					id: 'port',
					choices: this.device.outputChoices,
					default: this.device.outputChoices[0].id || '',
				},
				{
					label: 'Levels',
					type: 'multidropdown',
					id: 'levels',
					choices: this.device.levels,
					default: this.device.levels.map(choice => choice.id),
				}
			],
			callback: ({options}) => {
				for (let level of options.levels) {
					if (this.state.selectedDestination[level] == options.port) {
						this.state.selectedDestination[level] = 0xffff
					} else {
						this.state.selectedDestination[level] = options.port
					}
					this.checkFeedbacks('destinationSelected', 'route')
				}
			},
		}
		// MARK: action take salvo
		this.actions['takeSalvo'] = {
			name: 'Route selected ports',
			options: [
				{
					label: 'Levels',
					type: 'multidropdown',
					id: 'levels',
					choices: this.device.levels,
					default: this.device.levels.map(choice => choice.id),
				}
			],
			callback: ({options}) => {
				for (let level of options.levels) {
					if (this.state.selectedSource[level] && this.state.selectedDestination[level]) {
						this.XPT({ input: this.state.selectedSource[level], output: this.state.selectedDestination[level] , levels: [level]})
					}
				}
			},
		}

		this.setActionDefinitions(this.actions)
	}

	// MARK: init feedbacks
	initFeedbacks() {
		let instance = this
		const feedbacks = {}
		// MARK: feedback route
		feedbacks['route'] = {
			type: 'boolean',
			name: 'Route',
			description: 'Shows if an input is routed to an output',
			defaultStyle: {
				color: 0,
				bgcolor: 0xff0000,
			},
			options: [
				{
					label: 'Level',
					type: 'dropdown',
					id: 'level',
					choices: this.device.levels,
					default: this.device.levels[0].id,
				},
				{
					type: 'number',
					label: 'Input',
					id: 'input',
					tooltip: '0 = disconnected, -1 = selected',
					default: 1,
					min: -1,
					max: 512,
					step: 1,
				},
				{
					type: 'number',
					label: 'Output',
					id: 'output',
					tooltip: '0 = disconnected, -1 = selected',
					default: 1,
					min: -1,
					max: 512,
					step: 1,
				},
			],
			callback: ({options}) => {
				try {
					let outputnum =
						Math.round(options.output) >= 0
							? Math.round(options.output)
							: instance.state.selectedDestination[options.level] || 0
					let input = 
						Math.round(options.input) >= 0 
							? Math.round(options.input)
							: instance.state.selectedSource[options.level] || 0
					if (instance.state.destinationConnectionList[options.level][outputnum] == input) {
						return true
					} else {
						return false
					}
				} catch (error) {
					this.log('error', 'trying to read feedback status for an invalid input or output' + options.input + ' '+ options.output)
					return false
				}
			},
		}
		// MARK: feedback source selected
		feedbacks['sourceSelected'] = {
			type: 'boolean',
			name: 'source selected',
			description: 'Shows if an input is selected for routing',
			defaultStyle: {
				color: 0,
				bgcolor: 0x00ff00,
			},
			options: [
				{
					label: 'Level',
					type: 'dropdown',
					id: 'level',
					choices: this.device.levels,
					default: this.device.levels[0].id,
				},
				{
					type: 'number',
					label: 'Input',
					id: 'port',
					default: 1,
					min: 1,
					max: 512,
				},
			],
			callback: ({options}) => {
				try {
					if (instance.state.selectedSource[options.level] == Math.round(options.port)) {
						return true
					} else {
						return false
					}
				} catch (error) {
					this.log('error', 'trying to read feedback status for an invalid source')
					return false
				}
			},
		}
		// MARK: feedback destination selected
		feedbacks['destinationSelected'] = {
			type: 'boolean',
			name: 'destination selected',
			description: 'Shows if an output is selected for routing',
			defaultStyle: {
				color: 'rgb(0, 0, 0)',
				bgcolor: 'rgb(0, 255, 0)',
			},
			options: [
				{
					label: 'Level',
					type: 'dropdown',
					id: 'level',
					choices: this.device.levels,
					default: this.device.levels[0].id,
				},
				{
					type: 'number',
					label: 'Output',
					id: 'port',
					default: 1,
					min: 1,
					max: 512,
				},
			],
			callback: ({options}) => {
				try {
					if (instance.state.selectedDestination[options.level] == options.port) {
						return true
					} else {
						return false
					}
				} catch (error) {
					this.log('error', 'trying to read feedback status for an invalid destination')
					return false
				}
			},
		}

		this.setFeedbackDefinitions(feedbacks)
	}

	// MARK: init variables
	initVariables() {
		const varDef = [
			{ variableId: 'devicename', name: 'Type of device'}
		]
		for (const level of this.device.levels) {
			for (let outNum = 1; outNum <= this.device.outputs; outNum += 1) {
				varDef.push({ variableId: `output_${level.id}_${outNum}`, name: `Number of input assigned to ${level.label} output ${outNum}`})
				if (this.variables[`output_${level.id}_${outNum}`] === undefined) {
					this.variables[`output_${level.id}_${outNum}`] = '0'
				}
			}
		}
		this.setVariableDefinitions(varDef)
		this.variables['devicename'] = this.device.name
		this.setVariableValues( this.variables )
	}

	// MARK: init presets
	initPresets() {
		const presets = {}
		const createSelectPreset = (type, port, level) => {
			let pdat = {}
			pdat.type = { I: 'Input', O: 'Output' }[type] || ''
			pdat.action = { I: 'selectSource', O: 'selectDestination' }[type] || ''
			pdat.option = { I: 'source', O: 'destination' }[type] || ''

			presets[`selection${level.id}${type}${port}`] = {
				name: `Select ${pdat.type} ${port}`,
				type: 'button',
				category: `Select ${level.label} ${pdat.type}`,
				style: {
					text: `${level.label} ${pdat.type} ${port}`,
					size: 'auto',
					color: 'rgb(255, 255, 255)',
					bgcolor: 'rgb(30, 30, 30)',
				},
				steps: [
					{
						down: [
							{
								actionId: pdat.action,
								options: {
									levels: [level.id],
									port,
								},
							},
						],
						up: [],
					},
				],
				feedbacks: [
					{
						feedbackId: pdat.option + 'Selected',
						options: {
							level: level.id,
							port,
						},
						style: {
							color: 'rgb(0, 255, 0)',
							bgcolor: 'rgb(0, 70, 0)',
						},
					},
					{
						feedbackId: 'route',
						options: {
							level: level.id,
							input: type === 'I' ? port : -1,
							output: type === 'O' ? port : -1,
						},
						style: {
							bgcolor: 'rgb(150, 0, 0)',
						},
					},
				],
			}

			if (type === 'I')
				presets[`selectAndTake${level.id}I${port}`] = {
					name: `Select ${level.label} Input ${port} and Take`,
					type: 'button',
					category: `Select ${level.label} Input and Take`,
					style: {
						text: `${level.label} Input ${port}`,
						size: 'auto',
						color: 'rgb(255, 255, 255)',
						bgcolor: 'rgb(60, 0, 0)',
					},
					steps: [
						{
							down: [
								{
									actionId: pdat.action,
									options: {
										levels: [level.id],
										port,
									},
								},
								{
									actionId: 'takeSalvo',
								},
							],
							up: [],
						},
					],
					feedbacks: [
						{
							feedbackId: pdat.option + 'Selected',
							options: {
								level: level.id,
								port,
							},
							style: {
								color: 'rgb(0, 255, 0)',
								bgcolor: 'rgb(0, 70, 0)',
							},
						},
						{
							feedbackId: 'route',
							options: {
								level: level.id,
								input: type === 'I' ? port : -1,
								output: type === 'O' ? port : -1,
							},
							style: {
								bgcolor: 'rgb(150, 0, 0)',
							},
						},
					],
				}
		}

		for (let level of this.device.levels) {
			for (let input = 1; input <= this.device.inputs; input += 1) {
				createSelectPreset('I', input, level)
			}
			for (let output = 1; output <= this.device.outputs; output += 1) {
				createSelectPreset('O', output, level)
			}
		}

		// MARK: preset take
		presets['take'] = {
			type: 'button',
			name: 'Take Selected',
			type: 'button',
			category: 'Misc',
			style: {
				text: 'Take selected',
				size: 'auto',
				color: 'rgb(0, 0, 0)',
				bgcolor: 'rgb(180, 30, 30)',
			},
			steps: [
				{
					down: [
						{
							actionId: 'takeSalvo',
							options: {
								levels: this.device.levels.map(choice => choice.id)
							}
						},
					],
					up: [],
				},
			],
			feedbacks: [],
		}
		this.setPresetDefinitions(presets)
	}

	// MARK: init device
	initDevice() {
		// Get initial status of all crosspoints
		this.getDeviceRoutes()
	}

	// MARK: get device routes
	getDeviceRoutes() {
		this.sendCommand(`F${this.config.frame}Q`)
	}

	// MARK: init tcp
	initTCP() {
		let instance = this
		const maxBufferLength = 2048 
		let receivebuffer = []
		this.responseHandlers = {}

		if (this.socket !== undefined) {
			this.socket.destroy()
			delete this.socket
		}
		if (this.config.host) {
			this.socket = new TCPHelper(this.config.host, 23)

			this.socket.on('status_change', (status, message) => {
				instance.updateStatus(status, message)
				if (status === 'ok') {
					instance.startPolling()
				} else {
					instance.stopPolling()
				}
			})

			this.socket.on('connect', () => {
				instance.log('info', `Connection to device ${instance.config.host} established.`)
				instance.initDevice()
			})

			this.socket.on('error', (err) => {
				instance.log('error', 'Network error: ' + err.message)
			})

			this.socket.on('data', (chunkBuffer) => {
				const chunk = chunkBuffer.toString()
				const chunkArr = chunkBuffer.toJSON().data
				//console.log('incoming chunk', chunk, chunkArr)
				let index = 0,
					line = [],
					offset = 0
				receivebuffer.push(...chunkArr)
				if (receivebuffer.length > maxBufferLength) {
					receivebuffer = []
					this.log('error', 'Receive Buffer oveflow, flushing.')
				}

				while ((index = receivebuffer.indexOf(13, offset)) !== -1) {
					line = receivebuffer.slice(offset, index)
					offset = index + 1
					this.socket.emit('receiveline', line)
				}
				receivebuffer.splice(0, offset)
			})

			this.socket.on('receiveline', (line) => {
				if (line[0] !== 36 || line[1] !== 36) {
					// wrong header
					return
				}
				while (line[line.length-1] === 10 || line[line.length] === 13) line = line.pop() // get rid of trailing delimiters

				// if (instance.device.commandtype === 'checksum') line = line.slice(0, -1) // get rid of checksum, tcp transmission will guarantee integrity

				this.parseResponse(line)
			})
		}
	}

	// MARK: xpt command
	XPT(opt) {
		for (let level of opt.levels) {
			this.sendCommand(`F${this.config.frame}${level}${this.device.outputFormatter(opt.output)}I${this.device.inputFormatter(opt.input)}`)
		}
	}

	// MARK: send command
	sendCommand(command, addChecksum = true) {
		let commandstring = ''
		if (this.device.commandtype === 'checksum') commandstring = `//${command}`
		else commandstring = `\\${command}`
		let checksum = 0
		let checksumString = ''
		if (this.device.commandtype === 'checksum' && addChecksum) {
			checksum = Array.from(commandstring)
			.map(char => char.charCodeAt(0))
			.reduce((prev,curr) => { curr ^= prev; return curr }, 0)
			
			checksum |= 0b01000000 // Force bit six to high

			checksumString = String.fromCharCode( checksum )
		}
		if (this.socket !== undefined) {
			this.socket.send(`${commandstring}${checksumString}\r`)
			// console.log('sending', `${commandstring}${checksumString}<CR>`, checksum)
		} else {
			this.log('debug', 'Socket not connected :(')
		}
	}

	// MARK: parse response
	parseResponse(lineArr) {
		let line = String.fromCharCode(...lineArr)
		/**
		 * The subscriptions object holds all definitions for responses to react to
		 * @property pat a string with a regex to check incoming message
		 * @property fun a function to call when pat matches. When the function returnes true, choices and presets will be updated
		 * @property fbk the name of a feedback to check when pat matches
		 */
		let subscriptions = [
			{
				// Chrosspoint has changed
				pat: '^\\$\\$F\\d\\d[A-Z]\\d\\dI\\d\\d',
				fun: (res) => {
					const parts = res.match(/^\$\$F(\d\d)([A-Z])(\d\d)I(\d\d)/)
					if (!Array.isArray(parts)) {
						this.log('error', `received very malformed crosspoint status: ${res}`)
						return
					}
					let [_match, frame, level, outputString, inputString] = parts
					if (frame !== this.config.frame) {
						// received response for a different frame, ignore
						return
					}
					if (!this.device.levels.map(level => level.id).includes(level)) {
						this.log('warn', `received crosspoint status for level ${level}, but this device only has the levels: ${this.device.levels.map(level => `${level.id} (${level.label})`).join(', ')}`)
						return
					}
					let output = parseInt(outputString)
					if (isNaN(output) || output < 1 || output > this.device.outputs) {
						this.log('warn', `received crosspoint status for invalid output number ${outputString}, valid outputs are 1-${this.device.outputs}`)
						return
					}
					let input = parseInt(inputString)
					if (isNaN(input) || input < 1 || input > this.device.inputs) {
						this.log('warn', `received crosspoint status for invalid input number ${inputString}, valid inputs are 1-${this.device.inputs}`)
						return
					}
					this.state.destinationConnectionList[level][output] = input
					this.setVariableValues({[`output_${level}_${output}`]: input})
					// get a complete status, because routings may change also other crosspoints
					this.getDeviceRoutes()
				},
				fbk: 'route',
			},
			{
				// response from a query, level can not be determined from response, see deviceconfig
				pat: '^\\$\\$F\\d\\dQ.+',
				fun: (res) => {
					if (res.substring(3,5) !== this.config.frame) {
						// received response for a different frame, ignore
						return
					}
					const values = lineArr.slice(6)
					if (values.length < this.device.outputs) {
						this.log('error', 'got status response but it contained to few crosspoints')
						return
					}

					// we got status for all levels, parsing in order of device configuration
					const varObj = {}
					for (let level of this.device.levels) {
						if (typeof level.positionInQ === 'number') { 
							for (let output = 0; output < this.device.outputs; output += 1) {
								let inputNum = this.device.inputParser(values[level.positionInQ + output])
								this.state.destinationConnectionList[level.id][output + 1] = inputNum
								varObj[`output_${level.id}_${output + 1}`] = inputNum
							}
						}
					}
					this.setVariableValues(varObj)
					//console.log('parsing output', varObj)
				},
				fbk: 'route',
			},
		]
		let updateGui = false
		subscriptions
			.filter((sub) => {
				const regexp = new RegExp(sub.pat)
				if (line.match(regexp)) {
					return true
				}
				return false
			})
			.forEach((sub) => {
				if (sub.fun && typeof sub.fun === 'function') {
					let update = sub.fun(line)
					if (update === true) updateGui = true
				}
				if (sub.fbk && typeof sub.fbk === 'string') {
					this.checkFeedbacks(sub.fbk)
				}
			})
		if (updateGui) {
			this.updateGui()
		}
	}

	// MARK: update gui
	updateGui() {
		this.initActions()
		this.initFeedbacks()
		this.initVariables()
		this.initPresets()
	}

	// MARK: config updated
	configUpdated(config) {
		const oldconfig = {...this.config}
		this.config = config

		if (this.config.type != oldconfig.type) {
			this.device = this.deviceConfig(this.config.type)
			this.initState(this.state, this.device)
			this.updateGui()
		}

		if (this.config.host != oldconfig.host || this.socket === undefined) {
			this.initTCP()
		}


	}
}

runEntrypoint(UsbMatrixInstance, [])
