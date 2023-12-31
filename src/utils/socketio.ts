import { Socket } from "socket.io-client";
import * as mediasoupClient from "mediasoup-client";
import {
  DtlsParameters,
  RtpCapabilities,
  RtpParameters,
  Transport,
} from "mediasoup-client/lib/types";
import { Device } from "mediasoup-client";

let device: Device;
let rtpCapabilities: RtpCapabilities;

let producerTransport;
let consumerTransports: Transport[] = [];
let videoProducer;

const params = {
  encodings: [
    {
      rid: "r0",
      maxBitrate: 100000,
      scalabilityMode: "S1T3",
    },
    {
      rid: "r1",
      maxBitrate: 300000,
      scalabilityMode: "S1T3",
    },
  ],
  codecOptions: {
    videoGoogleStartBitrate: 1000,
  },
};

let videoParams: mediasoupClient.types.ProducerOptions;

export const streamSuccess = async (
  stream: MediaStream,
  socket: Socket,
  roomName: string,
): Promise<(MediaStream | undefined)[]> => {
  videoParams = { track: stream.getVideoTracks()[0], ...params };
  return await joinRoom(socket, roomName);
};

interface JoinRoomData {
  rtpCapabilities: RtpCapabilities;
}

const joinRoom = async (
  socket: Socket,
  roomName: string,
): Promise<(MediaStream | undefined)[]> => {
  return new Promise((resolve, reject) => {
    socket.emit("joinRoom", { roomName }, async (data: JoinRoomData) => {
      console.log("Router RTP Capabilities...");
      console.log(data.rtpCapabilities);
      rtpCapabilities = data.rtpCapabilities;
      try {
        const device = await createDevice(socket);
        resolve(device);
      } catch (error) {
        console.error("Failed to create device:", error);
        reject(error);
      }
    });
  });
};

const createDevice = async (
  socket: Socket,
): Promise<(MediaStream | undefined)[]> => {
  try {
    device = new mediasoupClient.Device();

    await device.load({
      routerRtpCapabilities: rtpCapabilities,
    });

    console.log("Device RTP Capabilities", device.rtpCapabilities);

    return await createSendTransport(socket);
  } catch (error) {
    if (error instanceof Error) {
      console.log(error.message);
      if (error.name === "UnsupportedError")
        console.warn("browser not supported");
    } else {
      console.log("An error occurred: ", error);
    }
  }

  return [undefined];
};

const createSendTransport = async (
  socket: Socket,
): Promise<(MediaStream | undefined)[]> => {
  let params;
  try {
    params = await new Promise((resolve, reject) => {
      socket.emit("createWebRtcTransport", { consumer: false }, (response) => {
        if (response.error) {
          reject(new Error(response.error));
        } else {
          resolve(response);
        }
      });
    });

    console.log(params.params);
    producerTransport = device.createSendTransport(params.params);

    producerTransport.on(
      "connect",
      (
        { dtlsParameters }: { dtlsParameters: DtlsParameters },
        callback: () => void,
        errback: (error: Error) => void,
      ) => {
        try {
          socket.emit("transport-connect", {
            dtlsParameters,
          });

          callback();
        } catch (error: unknown) {
          if (error instanceof Error) {
            errback(error);
          }
        }
      },
    );

    return new Promise((resolve, reject) => {
      let producerList: (MediaStream | undefined)[] = []; // 값을 저장할 외부 변수

      producerTransport.on(
        "produce",
        (
          parameters: {
            kind: string;
            rtpParameters: RtpParameters;
            appData: any;
          },
          callback: (arg0: { id: string }) => void,
          errback: (error: Error) => void,
        ) => {
          console.log(parameters);

          try {
            socket.emit(
              "transport-produce",
              {
                kind: parameters.kind,
                rtpParameters: parameters.rtpParameters,
                appData: parameters.appData,
              },
              async ({
                id,
                producersExist,
              }: {
                id: string;
                producersExist: boolean;
              }) => {
                callback({ id });

                if (producersExist) {
                  producerList = await getProducers(socket);
                  resolve(producerList);
                }
              },
            );
          } catch (error: unknown) {
            if (error instanceof Error) {
              reject(error);
            }
          }
        },
      );
      connectSendTransport();
    });
  } catch (error) {
    console.error(error);
  }

  return [undefined];
};

const connectSendTransport = async (): Promise<void> => {
  try {
    if (producerTransport) {
      videoProducer = await producerTransport.produce(videoParams);

      videoProducer?.on("trackended", () => {
        console.log("video track ended");
      });

      videoProducer?.on("transportclose", () => {
        console.log("video transport ended");
      });
    }
  } catch (error: any) {
    console.log(error);
  }
};

interface ParamsResponse {
  error?: string;
  id: string;
}

const getProducers = async (
  socket: Socket,
): Promise<(MediaStream | undefined)[]> => {
  const result = await new Promise((resolve, reject) => {
    socket.emit("getProducers", async (producerIds: string[]) => {
      console.log(producerIds);
      try {
        const results: (MediaStream | undefined)[] = [];
        for (const id of producerIds) {
          const consumerTransport = await signalNewConsumerTransport(
            id,
            socket,
          );
          results.push(consumerTransport);
        }
        resolve(results);
      } catch (error) {
        reject(error);
      }
    });
  });
  return result;
};

const consumingTransports: string[] = [];

export const signalNewConsumerTransport = (
  remoteProducerId: string,
  socket: Socket,
): Promise<MediaStream | undefined> => {
  return new Promise((resolve, reject) => {
    if (consumingTransports.includes(remoteProducerId)) {
      return;
    }
    consumingTransports.push(remoteProducerId);

    socket.emit(
      "createWebRtcTransport",
      { consumer: true },
      async ({ params }) => {
        console.log("PARAMS...");
        console.log(params);

        let consumerTransport: mediasoupClient.types.Transport;
        try {
          consumerTransport = device.createRecvTransport(params);
        } catch (error) {
          console.log(error);
          return;
        }

        consumerTransport.on(
          "connect",
          (
            {
              dtlsParameters,
            }: { dtlsParameters: mediasoupClient.types.DtlsParameters },
            callback,
            errback,
          ) => {
            try {
              socket.emit("transport-recv-connect", {
                dtlsParameters,
                serverConsumerTransportId: params.id,
              });
              callback();
            } catch (error: unknown) {
              if (error instanceof Error) {
                errback(error);
              }
            }
          },
        );

        await connectRecvTransport(
          consumerTransport,
          remoteProducerId,
          params.id,
          socket,
        )
          .then((result) => {
            resolve(result);
          })
          .catch((error) => {
            reject(error);
          });
      },
    );
  });
};

const getStream = (
  consumerTransport: Transport<mediasoupClient.types.AppData>,
  remoteProducerId: string,
  serverConsumerTransportId: string,
  socket: Socket,
): Promise<MediaStream> => {
  return new Promise((resolve, reject) => {
    socket.emit(
      "consume",
      {
        rtpCapabilities: device.rtpCapabilities,
        remoteProducerId,
        serverConsumerTransportId,
      },
      async ({ params }) => {
        console.log(`Consumer Params`);
        console.log(params);
        const consumer = await consumerTransport.consume({
          id: params.id,
          producerId: params.producerId,
          kind: params.kind,
          rtpParameters: params.rtpParameters,
        });

        consumerTransports = [
          ...consumerTransports,
          {
            consumerTransport,
            serverConsumerTransportId: params.id,
            producerId: remoteProducerId,
            consumer,
          },
        ];

        socket.emit("consumer-resume", {
          serverConsumerId: params.serverConsumerId,
        });

        try {
          const { track } = consumer;
          const mediaStream = new MediaStream([track]);
          console.log("here 1?");
          resolve(mediaStream);
          console.log("here 1?");
        } catch (error) {
          reject(error);
        }
      },
    );
  });
};

const connectRecvTransport = async (
  consumerTransport: Transport<mediasoupClient.types.AppData>,
  remoteProducerId: string,
  serverConsumerTransportId: string,
  socket: Socket,
): Promise<MediaStream | undefined> => {
  try {
    const mediaStream = await getStream(
      consumerTransport,
      remoteProducerId,
      serverConsumerTransportId,
      socket,
    );
    return mediaStream;
  } catch (error) {
    console.error("Failed to get the media stream:", error);
  }
};

// socket.on("producer-closed")
export const closeProducer = (remoteProducerId: string) => {
  const producerToClose = consumerTransports.find(
    (transportData) => transportData.appData.producerId === remoteProducerId,
  );

  if (!producerToClose) {
    console.log(`Cannot find producer with id ${remoteProducerId}`);
    return;
  }

  producerToClose.close();

  consumerTransports = consumerTransports.filter(
    (transportData) => transportData.appData.producerId !== remoteProducerId,
  );

  // todo: remove video
};
